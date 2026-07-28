//! 计费 / 盈亏看板持久化
//!
//! 把与"卖 API 赚不赚钱"相关、无法从用量日志推导的配置沉淀到 `billing.json`：
//! - `pricing`：各模型 4 类 token 售价（元/百万 token）+ 有缓存/无缓存两个收入倍率
//! - `accountPrices`：每个号（凭据）的买入价（号价），键为凭据 id
//! - `history`：号被删除时归档的一生盈亏快照，永久保留，供事后回看
//!
//! 用量本身（token / credit）来自 [`super::usage_stats`]，不在此存储。
//! 设计参考 `groups.rs` 的 RwLock + JSON 持久化模式。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// 单模型售价（元 / 百万 token）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub input_price: f64,
    pub output_price: f64,
    pub cache_write_price: f64,
    pub cache_read_price: f64,
}

/// 定价配置（收入侧）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pricing {
    /// 有缓存收入倍率
    pub cache_multiplier: f64,
    /// 无缓存收入倍率
    pub no_cache_multiplier: f64,
    /// 缓存上报比例（0.0~1.0）：返回给客户端的 cache_read 按此比例缩减，
    /// 多出来的部分归入 input_tokens。1.0=原样上报，0.0=全部报为 input。
    #[serde(default = "default_cache_report_ratio")]
    pub cache_report_ratio: f64,
    /// 按模型名索引的售价
    #[serde(default)]
    pub models: HashMap<String, ModelPrice>,
}

fn default_cache_report_ratio() -> f64 {
    1.0
}

impl Default for Pricing {
    fn default() -> Self {
        Self {
            cache_multiplier: 0.1,
            no_cache_multiplier: 0.12,
            cache_report_ratio: 1.0,
            models: HashMap::new(),
        }
    }
}

/// 已归档（删除）的号的一生盈亏快照
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedAccount {
    /// 原凭据 id（仅供参考，删除后 id 可能被复用）
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// 号价（成本）
    pub price: f64,
    /// 归档时该号累计消耗的 credit（受日志保留期限制，约近 31 天）
    pub lifetime_credits: f64,
    /// 归档时该号累计带来的收入（按 credit 占比分摊总收入）
    pub lifetime_revenue: f64,
    /// 归档时间（RFC3339）
    pub archived_at: String,
    /// 归档原因
    pub reason: String,
}

/// billing.json 的完整内容
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BillingData {
    #[serde(default)]
    pricing: Pricing,
    /// 号价：凭据 id -> 买入价
    #[serde(default)]
    account_prices: HashMap<u64, f64>,
    #[serde(default)]
    history: Vec<ArchivedAccount>,
    /// 已知模型 id 集合（点击「查看可用模型」时自动追加，用于定价编辑器）
    #[serde(default)]
    known_models: Vec<String>,
}

/// 计费存储（线程安全 + 自动持久化）
pub struct BillingStore {
    inner: RwLock<BillingData>,
    path: Option<PathBuf>,
}

impl BillingStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(BillingData::default()),
            path: None,
        }
    }

    /// 从 `billing.json` 加载（不存在时返回默认空存储）
    pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let data: BillingData = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            if content.trim().is_empty() {
                BillingData::default()
            } else {
                serde_json::from_str(&content)?
            }
        } else {
            BillingData::default()
        };
        Ok(Self {
            inner: RwLock::new(data),
            path: Some(path),
        })
    }

    fn save_locked(&self, data: &BillingData) {
        let path = match &self.path {
            Some(p) => p,
            None => return,
        };
        match serde_json::to_string_pretty(data) {
            Ok(json) => {
                if let Err(e) = std::fs::write(path, json) {
                    tracing::warn!("写入 billing.json 失败: {}", e);
                }
            }
            Err(e) => tracing::warn!("序列化 billing 数据失败: {}", e),
        }
    }

    /// 读取定价配置
    pub fn pricing(&self) -> Pricing {
        self.inner.read().pricing.clone()
    }

    /// 覆盖定价配置
    pub fn set_pricing(&self, pricing: Pricing) {
        let mut inner = self.inner.write();
        inner.pricing = pricing;
        self.save_locked(&inner);
    }

    /// 读取所有号价（凭据 id -> 号价）
    pub fn account_prices(&self) -> HashMap<u64, f64> {
        self.inner.read().account_prices.clone()
    }

    /// 查询单个号价
    pub fn account_price(&self, id: u64) -> Option<f64> {
        self.inner.read().account_prices.get(&id).copied()
    }

    /// 设置单个号价
    pub fn set_account_price(&self, id: u64, price: f64) {
        let mut inner = self.inner.write();
        inner.account_prices.insert(id, price);
        self.save_locked(&inner);
    }

    /// 读取已知模型列表（去重后的全集）
    pub fn known_models(&self) -> Vec<String> {
        self.inner.read().known_models.clone()
    }

    /// 追加新发现的模型 id（去重），有新增时才写盘
    pub fn merge_known_models(&self, models: &[String]) {
        let mut inner = self.inner.write();
        let mut changed = false;
        for m in models {
            if !inner.known_models.contains(m) {
                inner.known_models.push(m.clone());
                changed = true;
            }
        }
        if changed {
            inner.known_models.sort();
            self.save_locked(&inner);
        }
    }

    /// 读取历史归档（按归档时间倒序）
    pub fn history(&self) -> Vec<ArchivedAccount> {
        let mut list = self.inner.read().history.clone();
        list.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
        list
    }

    /// 归档一个被删除的号，并清掉它的号价条目。
    /// 号价优先用调用方显式传入的值，否则回退到已存的号价，再否则 0。
    pub fn archive(&self, mut account: ArchivedAccount) {
        let mut inner = self.inner.write();
        if account.price == 0.0 {
            if let Some(p) = inner.account_prices.get(&account.id) {
                account.price = *p;
            }
        }
        inner.account_prices.remove(&account.id);
        inner.history.push(account);
        self.save_locked(&inner);
    }
}

impl Default for BillingStore {
    fn default() -> Self {
        Self::new()
    }
}

/// 默认存储路径（相对凭据目录）
pub fn default_path_in(dir: &Path) -> PathBuf {
    dir.join("billing.json")
}

/// Arc 包装，便于注入 axum State
pub type SharedBillingStore = Arc<BillingStore>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pricing_has_multipliers() {
        let p = Pricing::default();
        assert!(p.cache_multiplier > 0.0);
        assert!(p.no_cache_multiplier > 0.0);
        assert!(p.models.is_empty());
    }

    #[test]
    fn set_and_get_account_price() {
        let store = BillingStore::new();
        store.set_account_price(7, 8.5);
        assert_eq!(store.account_price(7), Some(8.5));
        assert_eq!(store.account_prices().get(&7).copied(), Some(8.5));
    }

    #[test]
    fn archive_uses_stored_price_and_clears_it() {
        let store = BillingStore::new();
        store.set_account_price(3, 12.0);
        store.archive(ArchivedAccount {
            id: 3,
            email: Some("a@b.c".into()),
            price: 0.0, // 未显式传 → 回退到已存号价
            lifetime_credits: 40.0,
            lifetime_revenue: 6.5,
            archived_at: "2026-07-25T00:00:00Z".into(),
            reason: "手动删除".into(),
        });
        // 号价被搬走
        assert_eq!(store.account_price(3), None);
        let hist = store.history();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].price, 12.0);
    }

    #[test]
    fn history_sorted_desc_by_time() {
        let store = BillingStore::new();
        for (id, ts) in [(1, "2026-07-10T00:00:00Z"), (2, "2026-07-20T00:00:00Z")] {
            store.archive(ArchivedAccount {
                id,
                email: None,
                price: 1.0,
                lifetime_credits: 0.0,
                lifetime_revenue: 0.0,
                archived_at: ts.into(),
                reason: "x".into(),
            });
        }
        let hist = store.history();
        assert_eq!(hist[0].id, 2); // 最新在前
        assert_eq!(hist[1].id, 1);
    }

    #[test]
    fn save_roundtrip_preserves_data() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("kiro_test_billing_{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let store = BillingStore::load(&path).unwrap();
        let mut pricing = Pricing::default();
        pricing.cache_multiplier = 0.15;
        pricing.models.insert(
            "claude-opus-5".into(),
            ModelPrice {
                input_price: 15.0,
                output_price: 75.0,
                cache_write_price: 18.75,
                cache_read_price: 1.5,
            },
        );
        store.set_pricing(pricing);
        store.set_account_price(1, 8.0);

        let store2 = BillingStore::load(&path).unwrap();
        assert_eq!(store2.pricing().cache_multiplier, 0.15);
        assert_eq!(store2.pricing().models.len(), 1);
        assert_eq!(store2.account_price(1), Some(8.0));

        let _ = std::fs::remove_file(&path);
    }
}
