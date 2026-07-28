import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Coins, TrendingUp, TrendingDown, Wallet, Save, Copy, ClipboardPaste, ScrollText, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { ModelPrice, Pricing } from '@/api/billing'
import {
  useAccountPrices,
  useBillingByCredential,
  useBillingByModel,
  useBillingCredentials,
  useBillingHistory,
  usePricing,
  useSavePricing,
  useSetAccountPrice,
} from '@/hooks/use-billing'

// ————————————————————————————————————————————————————————————————
// 计费页（盈亏看板）
// 数据全部来自后端：
//   - 用量：/api/admin/stats/by-model + by-credential（含 cache/credits）
//   - 号池：/api/admin/credentials（email + balance + 禁用状态）
//   - 定价与号价：/api/admin/billing/*（持久化到 billing.json）
//   - 历史号：/api/admin/billing/history（删除时归档）
// 记账口径 B：真实每 credit 成本 = Σ号价 ÷ Σ已用credit（死号浪费自动摊入）。
// ————————————————————————————————————————————————————————————————

type BillingRange = '1h' | '24h' | '7d' | '30d'

const RANGES: { label: string; value: BillingRange }[] = [
  { label: '1 小时', value: '1h' },
  { label: '24 小时', value: '24h' },
  { label: '7 天', value: '7d' },
  { label: '30 天', value: '30d' },
]

const CNY = '¥'

/** 单模型用量（由后端 ModelDistribution 映射，cacheCreation→cacheWrite） */
interface ModelUsage {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  credits: number
}

/** 号池中的一个号（由凭据列表 + balance + 号价 + 本档 credit 占比派生） */
interface Account {
  id: number
  email: string
  /** 号价：买这个号花了多少钱（存后端 billing.json） */
  price: number
  /** 总额度（balance.usageLimit） */
  usageLimit: number
  /** 已用（balance.currentUsage） */
  currentUsage: number
  /** 是否已禁用（视作"死号"） */
  dead: boolean
  /** 该号占本时间档 credit 的比例（由 by-credential 聚合得出） */
  share: number
}

/** 历史号（已删除/归档）：删除时沉淀，永久保存，与活跃池脱钩 */
interface HistoryAccount {
  id: number
  email: string
  price: number
  lifetimeCredits: number
  lifetimeRevenue: number
  /** 归档时间（RFC3339） */
  archivedAt: string
  reason: string
}

const M = 1_000_000

/** 某模型的收入（有缓存/无缓存两口径），不含成本 */
function modelRevenue(u: ModelUsage, pricing: Pricing) {
  const p =
    pricing.models[u.model] ?? { inputPrice: 0, outputPrice: 0, cacheWritePrice: 0, cacheReadPrice: 0 }
  const rawRevenue =
    (u.inputTokens / M) * p.inputPrice +
    (u.outputTokens / M) * p.outputPrice +
    (u.cacheWriteTokens / M) * p.cacheWritePrice +
    (u.cacheReadTokens / M) * p.cacheReadPrice
  // 无缓存：缓存读写全部折算进输入价
  const rawNoCache =
    ((u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens) / M) * p.inputPrice +
    (u.outputTokens / M) * p.outputPrice
  return {
    revenue: rawRevenue * pricing.cacheMultiplier,
    noCacheRevenue: rawNoCache * pricing.noCacheMultiplier,
  }
}

/** 本时段成本汇总：每个号独立计算成本后求和 */
interface WindowCost {
  /** 本时段消耗的总 credit */
  winCredits: number
  /** 成本 = Σ(每个号本时段 credit × 该号单价) */
  cost: number
  /** 号池总投入 = Σ 号价 */
  totalInvest: number
}

function computeWindowCost(accounts: Account[], usage: ModelUsage[]): WindowCost {
  const winCredits = usage.reduce((s, u) => s + u.credits, 0)
  let totalInvest = 0
  let cost = 0
  for (const a of accounts) {
    totalInvest += a.price
    const unitCost = a.usageLimit > 0 ? a.price / a.usageLimit : 0
    const accountWinCredits = winCredits * a.share
    cost += accountWinCredits * unitCost
  }
  return { winCredits, cost, totalInvest }
}

interface ModelRow {
  usage: ModelUsage
  cost: number
  revenue: number
  noCacheRevenue: number
  profit: number
  noCacheProfit: number
}

/** 模型成本 = 该模型 credit 占比 × 总成本 */
function computeRows(usage: ModelUsage[], pricing: Pricing, totalCost: number): ModelRow[] {
  const totalCredits = usage.reduce((s, u) => s + u.credits, 0)
  return usage.map((u) => {
    const { revenue, noCacheRevenue } = modelRevenue(u, pricing)
    const share = totalCredits > 0 ? u.credits / totalCredits : 0
    const cost = totalCost * share
    return {
      usage: u,
      cost,
      revenue,
      noCacheRevenue,
      profit: revenue - cost,
      noCacheProfit: noCacheRevenue - cost,
    }
  })
}

function money(v: number): string {
  return `${CNY}${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function tokens(v: number): string {
  if (v >= M) return `${(v / M).toFixed(2)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`
  return String(v)
}

/** 单个号本时段的盈亏 */
interface AccountRow {
  account: Account
  /** 该号 credit 单价（号价 / 总额度） */
  unitCost: number
  /** 该号本时段消耗的 credit */
  winCredits: number
  /** 本时段成本 = 消耗 credit × credit 单价 */
  cost: number
  revenue: number
  profit: number
}

export function BillingPage() {
  const [range, setRange] = useState<BillingRange>('24h')

  const byModelQ = useBillingByModel(range)
  const byCredQ = useBillingByCredential(range)
  const credsQ = useBillingCredentials()
  const pricesQ = useAccountPrices()
  const pricingQ = usePricing()
  const historyQ = useBillingHistory()
  const savePricing = useSavePricing()
  const setAccountPrice = useSetAccountPrice()

  // 本地可编辑的定价副本，服务端数据到达时同步一次
  const [pricingDraft, setPricingDraft] = useState<Pricing | null>(null)
  useEffect(() => {
    if (pricingQ.data) setPricingDraft(pricingQ.data)
  }, [pricingQ.data])
  const pricing: Pricing = pricingDraft ?? { cacheMultiplier: 0.08, noCacheMultiplier: 0.12, cacheReportRatio: 1.0, models: {} }

  // by-model → ModelUsage（cacheCreation 记为 cacheWrite）
  const usage = useMemo<ModelUsage[]>(() => {
    return (byModelQ.data ?? []).map((m) => ({
      model: m.model,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheWriteTokens: m.cacheCreationTokens,
      cacheReadTokens: m.cacheReadTokens,
      credits: m.credits,
    }))
  }, [byModelQ.data])

  // 号池：凭据列表 + balance + 号价 + 本档 credit 占比
  const accounts = useMemo<Account[]>(() => {
    const creds = credsQ.data?.credentials ?? []
    const prices = pricesQ.data ?? {}
    const credDist = byCredQ.data ?? []
    const totalCredits = credDist.reduce((s, c) => s + c.credits, 0)
    const creditById = new Map(credDist.map((c) => [c.credentialId, c.credits]))
    return creds.map((c) => {
      const credits = creditById.get(c.id) ?? 0
      return {
        id: c.id,
        email: c.email ?? `#${c.id}`,
        price: prices[String(c.id)] ?? 0,
        usageLimit: c.balance?.usageLimit ?? 0,
        currentUsage: c.balance?.currentUsage ?? 0,
        dead: c.disabled,
        share: totalCredits > 0 ? credits / totalCredits : 0,
      }
    })
  }, [credsQ.data, pricesQ.data, byCredQ.data])

  const history = useMemo<HistoryAccount[]>(() => {
    return (historyQ.data ?? []).map((h) => ({
      id: h.id,
      email: h.email ?? `#${h.id}`,
      price: h.price,
      lifetimeCredits: h.lifetimeCredits,
      lifetimeRevenue: h.lifetimeRevenue,
      archivedAt: h.archivedAt,
      reason: h.reason,
    }))
  }, [historyQ.data])

  const cost = useMemo(() => computeWindowCost(accounts, usage), [accounts, usage])
  const rows = useMemo(() => computeRows(usage, pricing, cost.cost), [usage, pricing, cost])

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        revenue: acc.revenue + r.revenue,
        noCacheRevenue: acc.noCacheRevenue + r.noCacheRevenue,
      }),
      { revenue: 0, noCacheRevenue: 0 },
    )
  }, [rows])

  const totalCost = cost.cost
  const profit = totals.revenue - totalCost
  const noCacheProfit = totals.noCacheRevenue - totalCost
  const margin = totals.revenue > 0 ? (profit / totals.revenue) * 100 : 0
  const noCacheMargin = totals.noCacheRevenue > 0 ? (noCacheProfit / totals.noCacheRevenue) * 100 : 0

  // 每个号本时段的盈亏：各号独立单价 × 本时段消耗
  const accountRows = useMemo<AccountRow[]>(() => {
    return accounts.map((a) => {
      const unitCost = a.usageLimit > 0 ? a.price / a.usageLimit : 0
      const winCredits = cost.winCredits * a.share
      const c = winCredits * unitCost
      const rev = totals.revenue * a.share
      return {
        account: a,
        unitCost,
        winCredits,
        cost: c,
        revenue: rev,
        profit: rev - c,
      }
    })
  }, [accounts, totals.revenue, cost.winCredits])

  // 号价编辑：本地不缓存，直接落库（乐观刷新由 react-query invalidate 处理）
  const setPrice = (id: number, price: number) => {
    setAccountPrice.mutate(
      { id, price },
      { onError: () => toast.error('号价保存失败') },
    )
  }

  const onSavePricing = () => {
    if (!pricingDraft) return
    savePricing.mutate(pricingDraft, {
      onSuccess: () => toast.success('定价已保存'),
      onError: () => toast.error('定价保存失败'),
    })
  }

  const loading = byModelQ.isLoading || credsQ.isLoading || pricingQ.isLoading
  const errored = byModelQ.isError || credsQ.isError

  return (
    <div>
      <BillingHeader range={range} />
      <RangeTabs range={range} onChange={setRange} />
      {errored ? (
        <Card className="mb-4 border-rose-500/30">
          <CardContent className="p-5 text-sm text-rose-600 dark:text-rose-400">
            加载计费数据失败，请检查登录状态或稍后重试。
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载计费数据…
        </div>
      ) : (
        <>
          <HeadlineCards revenue={totals.revenue} cost={totalCost} profit={profit} margin={margin} />
          <SummaryCards
            winCredits={cost.winCredits}
            totalCost={totalCost}
            totalInvest={cost.totalInvest}
          />
          <ProfitCards
            revenue={totals.revenue}
            profit={profit}
            margin={margin}
            cost={totalCost}
            noCacheRevenue={totals.noCacheRevenue}
            noCacheProfit={noCacheProfit}
            noCacheMargin={noCacheMargin}
          />
          <DetailTable rows={rows} />
          <AccountPool rows={accountRows} onPriceChange={setPrice} />
          <HistoryPool history={history} onPriceChange={setPrice} />
          <PricingEditor
            pricing={pricing}
            models={usage.map((u) => u.model)}
            onChange={setPricingDraft}
            onSave={onSavePricing}
            saving={savePricing.isPending}
          />
        </>
      )}
    </div>
  )
}

const RANGE_LABEL: Record<BillingRange, string> = {
  '1h': '最近 1 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
}

function BillingHeader({ range }: { range: BillingRange }) {
  return (
    <div className="mb-6">
      <h1 className="text-[28px] font-semibold tracking-tight leading-tight">计费</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {RANGE_LABEL[range]}：成本 = Σ(每个号消耗 credit × 该号单价)；利润 = 收入 − 成本。
      </p>
    </div>
  )
}

function HeadlineCards(props: { revenue: number; cost: number; profit: number; margin: number }) {
  const positive = props.profit >= 0
  const profitColor = positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
  return (
    <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <TrendingUp className="h-4 w-4" />
            收入
          </div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{money(props.revenue)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">各模型 token × 售价 × 倍率</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Coins className="h-4 w-4" />
            成本
          </div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{money(props.cost)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">本时段消耗 credit × credit 单价</div>
        </CardContent>
      </Card>
      <Card className={positive ? 'border-emerald-500/30' : 'border-rose-500/30'}>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {positive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            利润
          </div>
          <div className={cn('mt-2 text-3xl font-semibold tabular-nums', profitColor)}>
            {positive ? '+' : ''}
            {money(props.profit)}
          </div>
          <div className={cn('mt-0.5 text-xs tabular-nums', profitColor)}>利润率 {props.margin.toFixed(1)}%</div>
        </CardContent>
      </Card>
    </div>
  )
}

function RangeTabs({ range, onChange }: { range: BillingRange; onChange: (r: BillingRange) => void }) {
  return (
    <div className="mb-4 flex items-center gap-1 rounded-full border border-border/60 p-0.5 w-fit">
      {RANGES.map((r) => (
        <Button
          key={r.value}
          size="sm"
          variant={range === r.value ? 'default' : 'ghost'}
          className="h-7 rounded-full px-3 text-xs"
          onClick={() => onChange(r.value)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  )
}

function SummaryCards(props: {
  winCredits: number
  totalCost: number
  totalInvest: number
}) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <StatCard
        icon={<Coins className="h-4 w-4" />}
        label="本时段消耗 credit"
        value={props.winCredits.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
        tone="neutral"
        sub="这段时间各号烧掉的额度"
      />
      <StatCard
        icon={<Coins className="h-4 w-4" />}
        label="本时段总成本"
        value={money(props.totalCost)}
        tone="neutral"
        sub="各号消耗 credit × 各自单价之和"
      />
      <StatCard
        icon={<Wallet className="h-4 w-4" />}
        label="号池总投入"
        value={money(props.totalInvest)}
        tone="neutral"
        sub="所有号价之和（参考）"
      />
    </div>
  )
}

function ProfitCards(props: {
  revenue: number
  profit: number
  margin: number
  cost: number
  noCacheRevenue: number
  noCacheProfit: number
  noCacheMargin: number
}) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
      <ProfitCard
        title="有缓存计费"
        revenue={props.revenue}
        profit={props.profit}
        margin={props.margin}
      />
      <ProfitCard
        title="无缓存计费"
        revenue={props.noCacheRevenue}
        profit={props.noCacheProfit}
        margin={props.noCacheMargin}
      />
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  tone,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'neutral' | 'pos' | 'neg'
  sub?: string
}) {
  const color =
    tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-rose-600 dark:text-rose-400' : ''
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className={cn('mt-2 text-2xl font-semibold tabular-nums', color)}>{value}</div>
        {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  )
}

function ProfitCard({
  title,
  revenue,
  profit,
  margin,
}: {
  title: string
  revenue: number
  profit: number
  margin: number
}) {
  const positive = profit >= 0
  const color = positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            {positive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {title}
          </span>
          <span className="text-xs">收入 {money(revenue)}</span>
        </div>
        <div className={cn('mt-2 text-2xl font-semibold tabular-nums', color)}>
          {profit >= 0 ? '+' : ''}
          {money(profit)}
        </div>
        <div className={cn('mt-0.5 text-xs tabular-nums', color)}>利润率 {margin.toFixed(1)}%</div>
      </CardContent>
    </Card>
  )
}

function DetailTable({ rows }: { rows: ModelRow[] }) {
  return (
    <Card className="mb-4">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-xs text-muted-foreground">
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-3 py-3 text-right font-medium">输入</th>
                <th className="px-3 py-3 text-right font-medium">输出</th>
                <th className="px-3 py-3 text-right font-medium">缓存写</th>
                <th className="px-3 py-3 text-right font-medium">缓存读</th>
                <th className="px-3 py-3 text-right font-medium">Credits</th>
                <th className="px-3 py-3 text-right font-medium">成本</th>
                <th className="px-3 py-3 text-right font-medium">有缓存利润</th>
                <th className="px-4 py-3 text-right font-medium">无缓存利润</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.usage.model} className="border-b border-border/40 last:border-0">
                  <td className="px-4 py-3 font-medium">{r.usage.model}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{tokens(r.usage.inputTokens)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{tokens(r.usage.outputTokens)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{tokens(r.usage.cacheWriteTokens)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{tokens(r.usage.cacheReadTokens)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.usage.credits.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{money(r.cost)}</td>
                  <ProfitCell value={r.profit} className="px-3" />
                  <ProfitCell value={r.noCacheProfit} className="px-4" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function ProfitCell({ value, className }: { value: number; className?: string }) {
  const positive = value >= 0
  return (
    <td
      className={cn(
        'py-3 text-right font-medium tabular-nums',
        className,
        positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
      )}
    >
      {positive ? '+' : ''}
      {money(value)}
    </td>
  )
}

/** 号价输入框：本地缓冲，onBlur 或回车时才保存，避免每次按键都发请求 */
function PriceInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  const commit = () => {
    const v = parseFloat(local) || 0
    if (v !== value) onChange(v)
  }
  return (
    <Input
      type="number"
      step="any"
      min={0}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
      className="h-8 w-24 text-right text-sm tabular-nums ml-auto"
    />
  )
}

function AccountPool({
  rows,
  onPriceChange,
}: {
  rows: AccountRow[]
  onPriceChange: (id: number, price: number) => void
}) {
  return (
    <Card className="mb-4">
      <CardContent className="p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4" />
          号池（每个号的成本与盈亏）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-xs text-muted-foreground">
                <th className="px-3 py-3 text-left font-medium">账号</th>
                <th className="px-3 py-3 text-left font-medium">状态</th>
                <th className="px-3 py-3 text-right font-medium">号价</th>
                <th className="px-3 py-3 text-right font-medium">总额度</th>
                <th className="px-3 py-3 text-right font-medium">剩余</th>
                <th className="px-3 py-3 text-right font-medium">真实单价</th>
                <th className="px-3 py-3 text-right font-medium">本时段消耗</th>
                <th className="px-3 py-3 text-right font-medium">成本</th>
                <th className="px-3 py-3 text-right font-medium">收入</th>
                <th className="px-3 py-3 text-right font-medium">盈亏</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const a = r.account
                const remaining = Math.max(0, a.usageLimit - a.currentUsage)
                return (
                  <tr key={a.id} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-3">
                      <div className="font-medium">{a.email}</div>
                      <div className="text-xs text-muted-foreground">#{a.id}</div>
                    </td>
                    <td className="px-3 py-3">
                      {a.dead ? (
                        <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-xs text-rose-600 dark:text-rose-400">
                          已死
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                          存活
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <PriceInput
                        value={a.price}
                        onChange={(v) => onPriceChange(a.id, v)}
                      />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{a.usageLimit}</td>
                    <td className={cn('px-3 py-3 text-right tabular-nums', a.dead && remaining > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
                      {remaining}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{CNY}{r.unitCost.toFixed(4)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.winCredits.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(r.cost)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{money(r.revenue)}</td>
                    <ProfitCell value={r.profit} className="px-3" />
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          本时段成本 = 该号本时段消耗 credit × 该号单价（号价÷总额度）；收入 = 按该号流量占比分摊总收入；盈亏 = 收入 − 成本。
          各号盈亏之和 = 顶部利润（可对账）。号价可直接编辑，改动即时反映到单价与成本。
        </p>
      </CardContent>
    </Card>
  )
}

function HistoryPool({ history, onPriceChange }: { history: HistoryAccount[]; onPriceChange: (id: number, price: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 20

  const totals = history.reduce(
    (acc, h) => ({
      price: acc.price + h.price,
      revenue: acc.revenue + h.lifetimeRevenue,
      profit: acc.profit + (h.lifetimeRevenue - h.price),
    }),
    { price: 0, revenue: 0, profit: 0 },
  )

  const totalPages = Math.ceil(history.length / PAGE_SIZE)
  const pagedHistory = history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <Card className="mb-4">
      <CardContent className="p-5">
        <button
          type="button"
          className="mb-1 flex w-full items-center gap-2 text-sm font-semibold text-left hover:text-primary transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <ScrollText className="h-4 w-4" />
          历史号（已删除 / 归档）
          <span className="text-xs font-normal text-muted-foreground">({history.length})</span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {expanded ? '收起 ▲' : '展开 ▼'}
          </span>
        </button>
        {expanded && (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              号被删除时自动沉淀，永久保留，可随时回看每个号一生的盈亏。数字为该号存活期间的累计（与上方时间档无关）。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="px-3 py-3 text-left font-medium">账号</th>
                    <th className="px-3 py-3 text-left font-medium">归档原因</th>
                    <th className="px-3 py-3 text-left font-medium">归档时间</th>
                    <th className="px-3 py-3 text-right font-medium">号价</th>
                    <th className="px-3 py-3 text-right font-medium">一生 credit</th>
                    <th className="px-3 py-3 text-right font-medium">一生收入</th>
                    <th className="px-3 py-3 text-right font-medium">最终盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedHistory.map((h) => (
                    <tr key={h.id} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-3">
                        <div className="font-medium">{h.email}</div>
                        <div className="text-xs text-muted-foreground">#{h.id}</div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{h.reason}</td>
                      <td className="px-3 py-3 text-muted-foreground tabular-nums">{h.archivedAt}</td>
                      <td className="px-3 py-3 text-right">
                        <PriceInput value={h.price} onChange={(v) => onPriceChange(h.id, v)} />
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{h.lifetimeCredits.toFixed(2)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{money(h.lifetimeRevenue)}</td>
                      <ProfitCell value={h.lifetimeRevenue - h.price} className="px-3" />
                    </tr>
                  ))}
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                        暂无历史号。删除号池里的号时会自动归档到这里。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border/60 text-xs">
                    <td className="px-3 py-3 font-medium" colSpan={3}>
                      历史合计
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(totals.price)}</td>
                    <td className="px-3 py-3" />
                    <td className="px-3 py-3 text-right tabular-nums">{money(totals.revenue)}</td>
                    <ProfitCell value={totals.profit} className="px-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function PricingEditor({
  pricing,
  models,
  onChange,
  onSave,
  saving,
}: {
  pricing: Pricing
  models: string[]
  onChange: (p: Pricing) => void
  onSave: () => void
  saving: boolean
}) {
  const setGlobal = (key: 'cacheMultiplier' | 'noCacheMultiplier' | 'cacheReportRatio', v: number) =>
    onChange({ ...pricing, [key]: v })

  const setModel = (model: string, key: keyof ModelPrice, v: number) => {
    const prev =
      pricing.models[model] ?? { inputPrice: 0, outputPrice: 0, cacheWritePrice: 0, cacheReadPrice: 0 }
    onChange({ ...pricing, models: { ...pricing.models, [model]: { ...prev, [key]: v } } })
  }

  // 价格剪贴板：复制某模型的 4 个价，粘贴到其它模型
  const [clip, setClip] = useState<ModelPrice | null>(null)
  const [clipFrom, setClipFrom] = useState<string | null>(null)
  const copyPrice = (model: string) => {
    const p =
      pricing.models[model] ?? { inputPrice: 0, outputPrice: 0, cacheWritePrice: 0, cacheReadPrice: 0 }
    setClip({ ...p })
    setClipFrom(model)
  }
  const pastePrice = (model: string) => {
    if (!clip) return
    onChange({ ...pricing, models: { ...pricing.models, [model]: { ...clip } } })
  }

  // 展示的模型 = 本时段有流量的模型 ∪ 已配置过价格的模型（配置过但当前无流量的也要能改）
  const allModels = useMemo(
    () => Array.from(new Set([...models, ...Object.keys(pricing.models)])).sort(),
    [models, pricing.models],
  )

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Wallet className="h-4 w-4" />
            定价设置
          </div>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存定价
          </Button>
        </div>

        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <PriceField
            label="有缓存倍率"
            suffix="×"
            value={pricing.cacheMultiplier}
            onChange={(v) => setGlobal('cacheMultiplier', v)}
          />
          <PriceField
            label="无缓存倍率"
            suffix="×"
            value={pricing.noCacheMultiplier}
            onChange={(v) => setGlobal('noCacheMultiplier', v)}
          />
          <PriceField
            label="缓存上报比例"
            suffix="0~1"
            value={pricing.cacheReportRatio}
            onChange={(v) => setGlobal('cacheReportRatio', v)}
          />
        </div>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">各模型售价（元 / 百万 token）</span>
          {clip && clipFrom ? (
            <span className="text-xs text-muted-foreground">
              已复制 <span className="font-medium text-foreground">{clipFrom}</span> 的价格，可粘贴到其它模型
            </span>
          ) : null}
        </div>
        <div className="space-y-3">
          {allModels.map((m) => {
            const p =
              pricing.models[m] ?? { inputPrice: 0, outputPrice: 0, cacheWritePrice: 0, cacheReadPrice: 0 }
            return (
              <div key={m} className="rounded-xl border border-border/50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">{m}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => copyPrice(m)}
                      title="复制该模型的价格"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => pastePrice(m)}
                      disabled={!clip || clipFrom === m}
                      title={clip ? `从 ${clipFrom} 粘贴价格` : '先点其它模型的“复制”'}
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      粘贴
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <PriceField label="输入" value={p.inputPrice} onChange={(v) => setModel(m, 'inputPrice', v)} />
                  <PriceField label="输出" value={p.outputPrice} onChange={(v) => setModel(m, 'outputPrice', v)} />
                  <PriceField label="缓存写" value={p.cacheWritePrice} onChange={(v) => setModel(m, 'cacheWritePrice', v)} />
                  <PriceField label="缓存读" value={p.cacheReadPrice} onChange={(v) => setModel(m, 'cacheReadPrice', v)} />
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function PriceField({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string
  suffix?: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">
        {label}
        {suffix ? <span className="ml-1 opacity-60">{suffix}</span> : null}
      </span>
      <Input
        type="number"
        step="any"
        min={0}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-8 text-sm tabular-nums"
      />
    </label>
  )
}
