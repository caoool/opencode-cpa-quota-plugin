import assert from "node:assert/strict"
import test from "node:test"
import {
  clampRefreshMs,
  MIN_REFRESH_MS,
  nextRefreshDelay,
  selectMissingCacheFallback,
  sharedCacheDisplayStatus,
  shouldAdoptCache,
  shouldPollAutomatically,
  snapshotSlotState,
  TIMER_SLACK_MS,
} from "../refresh-schedule"

test("honors a one-minute refresh interval and clamps only lower values", () => {
  assert.equal(clampRefreshMs(60_000), 60_000)
  assert.equal(clampRefreshMs(10_000), MIN_REFRESH_MS)
})

test("polls interactive processes and only opt-in auto workers", () => {
  assert.equal(shouldPollAutomatically(false, false), true)
  assert.equal(shouldPollAutomatically(false, true), true)
  assert.equal(shouldPollAutomatically(true, false), false)
  assert.equal(shouldPollAutomatically(true, true), true)
})

test("renders shared total failures as errors without reports and warnings with stale reports", () => {
  assert.equal(
    sharedCacheDisplayStatus({
      configuredStatus: "ready",
      readyStatus: "ready",
      errorStatus: "error",
      reportCount: 0,
      error: "management endpoint unavailable",
    }),
    "error",
  )
  assert.equal(
    sharedCacheDisplayStatus({
      configuredStatus: "ready",
      readyStatus: "ready",
      errorStatus: "error",
      reportCount: 1,
      error: "management endpoint unavailable",
    }),
    "ready",
  )
})

test("uses legacy only for pending initial migration, then preserves the latest cache", () => {
  const legacy = { checkedAt: 1, source: "legacy" }
  const latest = { checkedAt: 2, source: "shared" }

  assert.equal(
    selectMissingCacheFallback({ migrationPending: true, legacy, latest }),
    legacy,
  )
  assert.equal(
    selectMissingCacheFallback({ migrationPending: false, legacy, latest }),
    latest,
  )
})

test("reads quota state at the slot root so mounted UI invalidates", () => {
  let stateReads = 0
  let refreshingReads = 0
  const state = { checkedAt: 123 }

  const snapshot = snapshotSlotState(
    () => {
      stateReads += 1
      return state
    },
    () => {
      refreshingReads += 1
      return true
    },
  )

  assert.equal(snapshot.state, state)
  assert.equal(snapshot.refreshing, true)
  assert.equal(stateReads, 1)
  assert.equal(refreshingReads, 1)
})

test("schedules from the completed refresh instead of plugin startup", () => {
  const refreshMs = 600_000
  const checkedAt = 750

  assert.equal(nextRefreshDelay(checkedAt, refreshMs, checkedAt), refreshMs + TIMER_SLACK_MS)
})

test("reschedules only the remaining freshness window near a timer boundary", () => {
  const refreshMs = 600_000
  const checkedAt = 750
  const oldIntervalTick = 600_000

  assert.equal(nextRefreshDelay(checkedAt, refreshMs, oldIntervalTick), 1_000)
})

test("runs promptly when cached data is already stale", () => {
  assert.equal(nextRefreshDelay(1_000, 300_000, 301_000), TIMER_SLACK_MS)
})

test("bounds refresh delay when the system clock moves backwards", () => {
  assert.equal(nextRefreshDelay(400_000, 300_000, 100_000), 300_000 + TIMER_SLACK_MS)
})

test("adopts a newer shared-cache result from another process", () => {
  assert.equal(
    shouldAdoptCache({
      currentHasReports: true,
      currentVersion: 1_000,
      cacheHasReports: true,
      cacheVersion: 2_000,
    }),
    true,
  )
})

test("does not replace current reports with an older shared-cache result", () => {
  assert.equal(
    shouldAdoptCache({
      currentHasReports: true,
      currentVersion: 2_000,
      cacheHasReports: true,
      cacheVersion: 1_000,
    }),
    false,
  )
})

test("adopts shared cache when the current process has no reports", () => {
  assert.equal(
    shouldAdoptCache({
      currentHasReports: false,
      cacheHasReports: true,
    }),
    true,
  )
})

test("does not adopt an empty or equal-version cache", () => {
  assert.equal(
    shouldAdoptCache({
      currentHasReports: true,
      currentVersion: 2_000,
      cacheHasReports: false,
      cacheVersion: 3_000,
    }),
    false,
  )
  assert.equal(
    shouldAdoptCache({
      currentHasReports: true,
      currentVersion: 2_000,
      cacheHasReports: true,
      cacheVersion: 2_000,
    }),
    false,
  )
})
