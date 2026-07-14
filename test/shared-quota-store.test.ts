import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import {
  createSharedQuotaStore,
  InvalidSharedQuotaCacheError,
  LeaseLostError,
  MAX_CACHE_ERROR_LENGTH,
  quotaCache,
  type QuotaCache,
  type QuotaReport,
} from "../shared-quota-store"

const report: QuotaReport = {
  kind: "claude",
  account: "account-a",
  plan: "Max",
  windows: [{ id: "five_hour", label: "5h", used: 25, reset: "07/13 12:00" }],
}

function cache(checkedAt: number, used = 25): QuotaCache {
  return {
    reports: [{ ...report, windows: [{ ...report.windows[0]!, used }] }],
    updatedAt: checkedAt,
    checkedAt,
    failures: 0,
  }
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cpa-quota-store-"))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test("writes and reads the schema-v1 shared cache", async (t) => {
  const stateDir = await temporaryDirectory(t)
  let now = 1_800_000_000_000
  const store = createSharedQuotaStore({ stateDir, now: () => now, token: () => "store-a" })
  const lease = await store.acquireLease(10_000)
  assert.ok(lease)

  const expected = cache(now)
  await store.write(expected, lease)
  assert.deepEqual(await store.read(), expected)

  const raw = JSON.parse(await readFile(store.paths.cache, "utf8")) as Record<string, unknown>
  assert.equal(raw.schemaVersion, 1)
  assert.deepEqual(Object.keys(raw).sort(), ["checkedAt", "failures", "reports", "schemaVersion", "updatedAt"])
  assert.equal(await lease.release(), true)
})

test("roundtrips a normalized shared top-level error", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const now = 1_800_000_000_000
  const store = createSharedQuotaStore({ stateDir, now: () => now, token: () => "error-writer" })
  const lease = await store.acquireLease(10_000)
  assert.ok(lease)
  const expected: QuotaCache = {
    reports: [],
    checkedAt: now,
    failures: 1,
    error: "Management endpoint unavailable",
  }

  await store.write(expected, lease)
  assert.deepEqual(await store.read(), expected)
  const raw = JSON.parse(await readFile(store.paths.cache, "utf8")) as Record<string, unknown>
  assert.equal(raw.error, expected.error)

  const cleared = cache(now + 1, 30)
  await store.write(cleared, lease)
  assert.deepEqual(await store.read(), cleared)
  const clearedRaw = JSON.parse(await readFile(store.paths.cache, "utf8")) as Record<string, unknown>
  assert.equal("error" in clearedRaw, false)
  assert.equal(await lease.release(), true)
})

test("roundtrips independent provider refresh and backoff state", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const now = 1_800_000_000_000
  const store = createSharedQuotaStore({ stateDir, now: () => now, token: () => "provider-refresh" })
  const lease = await store.acquireLease(10_000)
  assert.ok(lease)
  const expected: QuotaCache = {
    ...cache(now),
    providerRefresh: {
      codex: { checkedAt: now, failures: 0 },
      claude: { checkedAt: now - 1_000, retryAt: now + 300_000, failures: 2 },
      grok: { checkedAt: now - 500, failures: 0 },
    },
  }

  await store.write(expected, lease)
  assert.deepEqual(await store.read(), expected)
  const raw = JSON.parse(await readFile(store.paths.cache, "utf8")) as Record<string, unknown>
  assert.deepEqual(raw.providerRefresh, expected.providerRefresh)
  assert.equal(await lease.release(), true)
})

test("repairs corrupt JSON only while holding the shared lease", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const now = 1_800_000_000_000
  const store = createSharedQuotaStore({ stateDir, now: () => now, token: () => "corrupt-repair" })
  await mkdir(store.paths.directory, { recursive: true, mode: 0o700 })
  await writeFile(store.paths.cache, "{not-json", { mode: 0o600 })
  await assert.rejects(store.read(), InvalidSharedQuotaCacheError)

  const lease = await store.acquireLease(10_000)
  assert.ok(lease)
  const fallback = cache(now, 15)
  await store.write(fallback, lease)
  assert.deepEqual(await store.read(), fallback)
  assert.equal(await lease.release(), true)
})

test("repairs a wrong-schema cache under the shared lease", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const now = 1_800_000_000_000
  const store = createSharedQuotaStore({ stateDir, now: () => now, token: () => "schema-repair" })
  await mkdir(store.paths.directory, { recursive: true, mode: 0o700 })
  await writeFile(store.paths.cache, JSON.stringify({ schemaVersion: 99, reports: [] }), { mode: 0o600 })
  await assert.rejects(store.read(), InvalidSharedQuotaCacheError)

  const lease = await store.acquireLease(10_000)
  assert.ok(lease)
  const fallback = quotaCache({ reports: [], checkedAt: now, failures: 0, error: "Recovered safely" })
  await store.write(fallback, lease)
  assert.deepEqual(await store.read(), fallback)
  assert.equal(await lease.release(), true)
})

test("allows only one lease winner across independent store instances", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const now = Date.now()
  const first = createSharedQuotaStore({ stateDir, now: () => now, token: () => "winner-a" })
  const second = createSharedQuotaStore({ stateDir, now: () => now, token: () => "winner-b" })

  const leases = await Promise.all([first.acquireLease(10_000), second.acquireLease(10_000)])
  assert.equal(leases.filter(Boolean).length, 1)
  const winner = leases.find((lease) => lease !== undefined)
  assert.ok(winner)
  assert.equal(await winner.release(), true)
})

test("recovers an expired lock and keeps release owner-safe", async (t) => {
  const stateDir = await temporaryDirectory(t)
  let now = 1_800_000_000_000
  const first = createSharedQuotaStore({ stateDir, now: () => now, token: () => "old-owner" })
  const second = createSharedQuotaStore({ stateDir, now: () => now, token: () => "new-owner" })
  const oldLease = await first.acquireLease(100)
  assert.ok(oldLease)

  now += 1_000
  const newLease = await second.acquireLease(100)
  assert.ok(newLease)
  assert.equal(await oldLease.release(), false)
  assert.equal(await newLease.renew(), true)
  assert.equal(await newLease.release(), true)
})

test("waits for a recent empty lock and recovers it after the incomplete-lock grace period", async (t) => {
  const stateDir = await temporaryDirectory(t)
  let now = 1_800_000_000_000
  const store = createSharedQuotaStore({
    stateDir,
    now: () => now,
    token: () => "recovered-owner",
    incompleteGraceMs: 100,
  })
  await mkdir(store.paths.directory, { recursive: true, mode: 0o700 })
  await mkdir(store.paths.lock, { mode: 0o700 })
  const created = new Date(now)
  await utimes(store.paths.lock, created, created)

  assert.equal(await store.acquireLease(1_000), undefined)
  now += 1_000

  const lease = await store.acquireLease(1_000)
  assert.ok(lease)
  assert.equal(await lease.release(), true)
})

test("does not let an expired owner publish a cache result", async (t) => {
  const stateDir = await temporaryDirectory(t)
  let now = 1_800_000_000_000
  const first = createSharedQuotaStore({ stateDir, now: () => now, token: () => "expired-owner" })
  const second = createSharedQuotaStore({ stateDir, now: () => now, token: () => "replacement-owner" })
  const lease = await first.acquireLease(100)
  assert.ok(lease)
  await first.write(cache(now, 10), lease)

  now += 1_000
  await assert.rejects(first.write(cache(now, 90), lease), LeaseLostError)
  assert.equal((await first.read())?.reports[0]?.windows[0]?.used, 10)

  const replacement = await second.acquireLease(1_000)
  assert.ok(replacement)
  await second.write(cache(now, 50), replacement)
  assert.equal((await first.read())?.reports[0]?.windows[0]?.used, 50)
  assert.equal(await replacement.release(), true)
})

test("migrates only normalized cache fields and never persists credential sentinels", async (t) => {
  const stateDir = await temporaryDirectory(t)
  const sentinel = "DO-NOT-PERSIST-MANAGEMENT-KEY"
  const store = createSharedQuotaStore({
    stateDir,
    now: () => 1_800_000_000_000,
    token: () => "migration-owner",
  })
  const legacy = {
    reports: [
      {
        ...report,
        credential: sentinel,
        windows: [{ ...report.windows[0], credential: sentinel }],
      },
    ],
    updatedAt: "1000",
    checkedAt: 2000,
    retryAt: "3000",
    failures: "2",
    error: "  management\n endpoint unavailable  ",
    leaseOwner: sentinel,
    leaseUntil: 9999,
    baseURL: sentinel,
    managementKey: sentinel,
  }

  const result = await store.initializeFromLegacy(legacy, 10_000)
  assert.equal(result.migrated, true)
  assert.equal(result.busy, false)
  assert.deepEqual(result.cache, {
    reports: [report],
    updatedAt: 1000,
    checkedAt: 2000,
    retryAt: 3000,
    failures: 2,
    error: "management endpoint unavailable",
  })

  const raw = await readFile(store.paths.cache, "utf8")
  assert.equal(raw.includes(sentinel), false)
  assert.equal(raw.includes("leaseOwner"), false)
  assert.equal(raw.includes("leaseUntil"), false)
  assert.equal(raw.includes("managementKey"), false)
  assert.deepEqual(await store.read(), result.cache)
})

test("a second store sees updates and an existing shared cache wins over legacy migration", async (t) => {
  const stateDir = await temporaryDirectory(t)
  let now = 1_800_000_000_000
  const first = createSharedQuotaStore({ stateDir, now: () => now, token: () => "writer-a" })
  const second = createSharedQuotaStore({ stateDir, now: () => now, token: () => "writer-b" })

  const firstLease = await first.acquireLease(10_000)
  assert.ok(firstLease)
  await first.write(cache(now, 20), firstLease)
  assert.equal(await firstLease.release(), true)
  assert.equal((await second.read())?.reports[0]?.windows[0]?.used, 20)

  const migration = await second.initializeFromLegacy(cache(now - 1_000, 99), 10_000)
  assert.equal(migration.migrated, false)
  assert.equal(migration.cache?.reports[0]?.windows[0]?.used, 20)

  now += 1_000
  const secondLease = await second.acquireLease(10_000)
  assert.ok(secondLease)
  await second.write(cache(now, 40), secondLease)
  assert.equal(await secondLease.release(), true)
  assert.equal((await first.read())?.reports[0]?.windows[0]?.used, 40)
})

test("strict cache normalization drops invalid reports and legacy lease fields", () => {
  const longError = `  failed\n${"x".repeat(MAX_CACHE_ERROR_LENGTH * 2)}  `
  const normalized = quotaCache({
    reports: [report, { kind: "unknown", account: "bad", windows: [] }],
    failures: -3,
    error: longError,
    leaseOwner: "legacy",
    leaseUntil: 123,
    managementKey: "DO-NOT-PERSIST",
  })

  assert.equal(normalized.error?.includes("\n"), false)
  assert.equal(normalized.error?.length, MAX_CACHE_ERROR_LENGTH)
  const { error: _error, ...withoutError } = normalized
  assert.deepEqual(withoutError, { reports: [report], failures: 0 })
})

test("strict cache normalization keeps only known provider refresh entries", () => {
  const normalized = quotaCache({
    reports: [report],
    failures: 0,
    providerRefresh: {
      claude: { checkedAt: "2000", retryAt: 3000, failures: "2" },
      unknown: { checkedAt: 9999, failures: 10 },
      codex: { failures: -1 },
    },
  })

  assert.deepEqual(normalized.providerRefresh, {
    claude: { checkedAt: 2000, retryAt: 3000, failures: 2 },
  })
})
