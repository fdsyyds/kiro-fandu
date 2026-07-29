import axios from 'axios'
import { storage } from '@/lib/storage'

const api = axios.create({
  baseURL: '/api/admin',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) config.headers['x-api-key'] = apiKey
  return config
})

/** 单模型售价（元 / 百万 token） */
export interface ModelPrice {
  inputPrice: number
  outputPrice: number
  cacheWritePrice: number
  cacheReadPrice: number
}

/** 定价配置（收入侧） */
export interface Pricing {
  claudeCacheMultiplier: number
  claudeNoCacheMultiplier: number
  gptCacheMultiplier: number
  gptNoCacheMultiplier: number
  models: Record<string, ModelPrice>
}

/** 已归档（删除）号的一生盈亏快照 */
export interface ArchivedAccount {
  id: number
  email?: string | null
  price: number
  lifetimeCredits: number
  lifetimeRevenue: number
  archivedAt: string
  reason: string
}

export async function getPricing(): Promise<Pricing> {
  const { data } = await api.get<Pricing>('/billing/pricing')
  return data
}

export async function savePricing(pricing: Pricing): Promise<void> {
  await api.put('/billing/pricing', pricing)
}

/** 号价：凭据 id（字符串键）-> 号价 */
export async function getAccountPrices(): Promise<Record<string, number>> {
  const { data } = await api.get<Record<string, number>>('/billing/account-prices')
  return data
}

export async function setAccountPrice(id: number, price: number): Promise<void> {
  await api.put(`/billing/account-prices/${id}`, { price })
}

export async function getHistory(): Promise<ArchivedAccount[]> {
  const { data } = await api.get<ArchivedAccount[]>('/billing/history')
  return data
}

export async function getKnownModels(): Promise<string[]> {
  const { data } = await api.get<string[]>('/billing/known-models')
  return data
}
