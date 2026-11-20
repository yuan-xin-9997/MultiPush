/** Human-readable labels for provider routing / failover reason codes. */
export const ROUTE_REASONS: Record<string, string> = {
  quota_exhausted: '额度不足',
  unauthorized: 'Key 失效',
  rate_limited: '触发限流',
  provider_error: '服务异常',
  network_error: '网络错误',
  invalid_response: '响应异常',
  model_unavailable: '模型不可用',
  provider_bad_request: '请求被拒绝',
  keys_unavailable: '提供商 Key 全部不可用',
  consecutive_failures: '连续失败',
  provider_probe_failed: '提供商探活失败',
  primary_unavailable: '主提供商暂不可用',
  primary_cooling: '主提供商冷却中',
}

export function routeReasonLabel(reason: string | null | undefined, fallback = '自动切换'): string {
  if (!reason) return fallback
  return ROUTE_REASONS[reason] ?? reason
}
