import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAccountPrices,
  getHistory,
  getPricing,
  savePricing,
  setAccountPrice,
  type Pricing,
} from '@/api/billing'
import { getByCredential, getByModel } from '@/api/stats'
import { getCredentials } from '@/api/credentials'
import type { StatsTimeFilter } from '@/types/api'

const COMMON = {
  refetchInterval: 30_000,
  staleTime: 25_000,
  placeholderData: keepPreviousData,
  refetchOnWindowFocus: false,
} as const

/** 计费时间档：1h/24h 走小时桶，7d/30d 走天桶 */
export type BillingRange = '1h' | '24h' | '7d' | '30d'

export function rangeToTimeFilter(range: BillingRange): StatsTimeFilter {
  const granularity = range === '1h' || range === '24h' ? 'hour' : 'day'
  // StatsTimeFilter.range 类型只声明了 24h/7d/30d，这里 1h 是后端新增档，用 as 放行
  return { range: range as StatsTimeFilter['range'], granularity }
}

function rangeKey(range: BillingRange) {
  return ['billing', range] as const
}

export function useBillingByModel(range: BillingRange) {
  const time = rangeToTimeFilter(range)
  return useQuery({
    queryKey: [...rangeKey(range), 'by-model'],
    queryFn: () => getByModel(time),
    ...COMMON,
  })
}

export function useBillingByCredential(range: BillingRange) {
  const time = rangeToTimeFilter(range)
  return useQuery({
    queryKey: [...rangeKey(range), 'by-credential'],
    queryFn: () => getByCredential(time),
    ...COMMON,
  })
}

export function useBillingCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
    refetchInterval: 30_000,
  })
}

export function useAccountPrices() {
  return useQuery({
    queryKey: ['billing', 'account-prices'],
    queryFn: getAccountPrices,
    staleTime: 60_000,
  })
}

export function usePricing() {
  return useQuery({
    queryKey: ['billing', 'pricing'],
    queryFn: getPricing,
    staleTime: 60_000,
  })
}

export function useBillingHistory() {
  return useQuery({
    queryKey: ['billing', 'history'],
    queryFn: getHistory,
    staleTime: 60_000,
  })
}

export function useSetAccountPrice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, price }: { id: number; price: number }) => setAccountPrice(id, price),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing', 'account-prices'] }),
  })
}

export function useSavePricing() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pricing: Pricing) => savePricing(pricing),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing', 'pricing'] }),
  })
}
