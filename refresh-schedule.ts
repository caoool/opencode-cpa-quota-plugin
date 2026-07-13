export const TIMER_SLACK_MS = 250
export const MIN_REFRESH_MS = 60_000

export function clampRefreshMs(value: number) {
  return Math.max(MIN_REFRESH_MS, value)
}

export function nextRefreshDelay(checkedAt: number, refreshMs: number, now: number) {
  return Math.min(
    refreshMs + TIMER_SLACK_MS,
    Math.max(TIMER_SLACK_MS, checkedAt + refreshMs + TIMER_SLACK_MS - now),
  )
}

export function shouldAdoptCache(input: {
  currentHasReports: boolean
  currentVersion?: number
  cacheHasReports: boolean
  cacheVersion?: number
}) {
  if (!input.cacheHasReports) return false
  if (!input.currentHasReports) return true
  return (input.cacheVersion ?? Number.NEGATIVE_INFINITY) > (input.currentVersion ?? Number.NEGATIVE_INFINITY)
}
