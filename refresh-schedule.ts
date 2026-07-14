export const TIMER_SLACK_MS = 250
export const MIN_REFRESH_MS = 60_000

export type ProviderRefreshWindow = {
  checkedAt?: number
  retryAt?: number
}

export function clampRefreshMs(value: number) {
  return Math.max(MIN_REFRESH_MS, value)
}

export function shouldPollAutomatically(autoMode: boolean, pollInAutoMode: boolean) {
  return !autoMode || pollInAutoMode
}

export function sharedCacheDisplayStatus<Status extends string>(input: {
  configuredStatus: Status
  readyStatus: Status
  errorStatus: Status
  reportCount: number
  error?: string
}) {
  if (input.configuredStatus !== input.readyStatus) return input.configuredStatus
  return input.error && input.reportCount === 0 ? input.errorStatus : input.readyStatus
}

export function selectMissingCacheFallback<Cache>(input: {
  migrationPending: boolean
  legacy: Cache
  latest: Cache
}) {
  return input.migrationPending ? input.legacy : input.latest
}

export function snapshotSlotState<State>(state: () => State, refreshing: () => boolean) {
  return {
    state: state(),
    refreshing: refreshing(),
  }
}

export function nextRefreshDelay(checkedAt: number, refreshMs: number, now: number) {
  return Math.min(
    refreshMs + TIMER_SLACK_MS,
    Math.max(TIMER_SLACK_MS, checkedAt + refreshMs + TIMER_SLACK_MS - now),
  )
}

export function dueProviderRefreshes<Kind extends string>(input: {
  kinds: readonly Kind[]
  refresh: Partial<Record<Kind, ProviderRefreshWindow>>
  refreshMs: number
  now: number
  force?: boolean
}) {
  return input.kinds.filter((kind) => {
    const refresh = input.refresh[kind]
    if (refresh?.retryAt !== undefined) return refresh.retryAt <= input.now
    if (input.force) return true
    return refresh?.checkedAt === undefined || input.now - refresh.checkedAt >= input.refreshMs
  })
}

export function nextProviderRefreshDelay<Kind extends string>(input: {
  kinds: readonly Kind[]
  refresh: Partial<Record<Kind, ProviderRefreshWindow>>
  refreshMs: number
  now: number
}) {
  if (!input.kinds.length) return TIMER_SLACK_MS
  return Math.min(
    ...input.kinds.map((kind) => {
      const refresh = input.refresh[kind]
      if (refresh?.retryAt !== undefined) {
        return Math.max(TIMER_SLACK_MS, refresh.retryAt - input.now + TIMER_SLACK_MS)
      }
      if (refresh?.checkedAt === undefined) return TIMER_SLACK_MS
      return Math.min(
        input.refreshMs + TIMER_SLACK_MS,
        Math.max(TIMER_SLACK_MS, refresh.checkedAt + input.refreshMs + TIMER_SLACK_MS - input.now),
      )
    }),
  )
}

export function latestRefreshAt(values: readonly (number | undefined)[]) {
  const timestamps = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return timestamps.length ? Math.max(...timestamps) : undefined
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
