import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, utimes } from "node:fs/promises"
import { join } from "node:path"

export type ProviderKind = "codex" | "claude" | "grok"

export type QuotaWindow = {
  id: string
  label: string
  used: number
  reset?: string
}

export type QuotaReport = {
  kind: ProviderKind
  account: string
  plan?: string
  windows: QuotaWindow[]
  error?: string
}

export type QuotaCache = {
  reports: QuotaReport[]
  updatedAt?: number
  checkedAt?: number
  retryAt?: number
  failures: number
  error?: string
}

export type SharedQuotaStorePaths = {
  directory: string
  cache: string
  lock: string
}

export type SharedQuotaLease = {
  readonly owner: string
  renew(): Promise<boolean>
  release(): Promise<boolean>
}

export type SharedQuotaStoreOptions = {
  stateDir: string
  now?: () => number
  token?: () => string
  incompleteGraceMs?: number
}

export type MigrationResult = {
  cache?: QuotaCache
  migrated: boolean
  busy: boolean
}

type OwnerMarker = {
  schemaVersion: 1
  owner: string
  ttlMs: number
}

type MarkerSnapshot = {
  name: string
  path: string
  marker: OwnerMarker
  stat: Stats
}

const CACHE_SCHEMA_VERSION = 1
const CACHE_DIRECTORY = "cpa-quota-sidebar"
const CACHE_FILE = "cache.v1.json"
const LOCK_DIRECTORY = "refresh.v1.lock"
const DEFAULT_INCOMPLETE_GRACE_MS = 2_000
const MAX_CACHE_BYTES = 1_000_000
const MAX_MARKER_BYTES = 4_096
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_CACHE_ERROR_LENGTH = 500

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function number(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(result) ? result : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cacheError(value: unknown) {
  const result = string(value)
  if (!result) return undefined
  const normalized = result.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()
  return normalized.slice(0, MAX_CACHE_ERROR_LENGTH).trimEnd() || undefined
}

function providerKind(value: unknown): ProviderKind | undefined {
  return value === "codex" || value === "claude" || value === "grok" ? value : undefined
}

function quotaWindow(value: unknown): QuotaWindow | undefined {
  const source = record(value)
  const id = string(source.id)
  const label = string(source.label)
  const used = number(source.used)
  if (!id || !label || used === undefined) return undefined
  const reset = string(source.reset)
  return {
    id,
    label,
    used: Math.min(100, Math.max(0, used)),
    ...(reset ? { reset } : {}),
  }
}

function quotaReport(value: unknown): QuotaReport | undefined {
  const source = record(value)
  const kind = providerKind(source.kind)
  const account = string(source.account)
  if (!kind || !account) return undefined
  const plan = string(source.plan)
  const error = string(source.error)
  const windows = Array.isArray(source.windows)
    ? source.windows.map(quotaWindow).filter((item): item is QuotaWindow => Boolean(item))
    : []
  return {
    kind,
    account,
    ...(plan ? { plan } : {}),
    windows,
    ...(error ? { error } : {}),
  }
}

/** Normalize both legacy KV values and schema-v1 file payloads into display-only cache data. */
export function quotaCache(value: unknown): QuotaCache {
  const source = record(value)
  const reports = Array.isArray(source.reports)
    ? source.reports.map(quotaReport).filter((item): item is QuotaReport => Boolean(item))
    : []
  const updatedAt = number(source.updatedAt)
  const checkedAt = number(source.checkedAt)
  const retryAt = number(source.retryAt)
  const failures = Math.max(0, Math.floor(number(source.failures) ?? 0))
  const error = cacheError(source.error)
  return {
    reports,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(retryAt === undefined ? {} : { retryAt }),
    failures,
    ...(error ? { error } : {}),
  }
}

function diskCache(value: unknown) {
  const cache = quotaCache(value)
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    reports: cache.reports,
    ...(cache.updatedAt === undefined ? {} : { updatedAt: cache.updatedAt }),
    ...(cache.checkedAt === undefined ? {} : { checkedAt: cache.checkedAt }),
    ...(cache.retryAt === undefined ? {} : { retryAt: cache.retryAt }),
    failures: cache.failures,
    ...(cache.error ? { error: cache.error } : {}),
  }
}

function errorCode(error: unknown) {
  return record(error).code
}

function hasCode(error: unknown, ...codes: string[]) {
  const code = errorCode(error)
  return typeof code === "string" && codes.includes(code)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sameStat(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

async function writeExclusiveSynced(path: string, value: string) {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function safeUnlink(path: string) {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false
    throw error
  }
}

async function safeRmdir(path: string) {
  try {
    await rmdir(path)
    return true
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    if (hasCode(error, "ENOTEMPTY", "EEXIST")) return false
    throw error
  }
}

export class SharedQuotaStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SharedQuotaStoreError"
  }
}

export class InvalidSharedQuotaCacheError extends SharedQuotaStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "InvalidSharedQuotaCacheError"
  }
}

export class LeaseLostError extends SharedQuotaStoreError {
  constructor(message = "Shared quota refresh lease was lost") {
    super(message)
    this.name = "LeaseLostError"
  }
}

class FileQuotaLease implements SharedQuotaLease {
  #released = false

  constructor(
    private readonly store: SharedQuotaStore,
    readonly owner: string,
  ) {}

  async renew() {
    if (this.#released) return false
    const renewed = await this.store.renewLease(this.owner)
    if (!renewed) this.#released = true
    return renewed
  }

  async release() {
    if (this.#released) return false
    const released = await this.store.releaseLease(this.owner)
    this.#released = true
    return released
  }
}

export class SharedQuotaStore {
  readonly paths: SharedQuotaStorePaths
  private readonly now: () => number
  private readonly token: () => string
  private readonly incompleteGraceMs: number
  private readonly leases = new WeakSet<object>()
  private tempSequence = 0

  constructor(options: SharedQuotaStoreOptions) {
    if (!string(options.stateDir)) throw new SharedQuotaStoreError("OpenCode state directory is unavailable")
    this.paths = {
      directory: join(options.stateDir, CACHE_DIRECTORY),
      cache: join(options.stateDir, CACHE_DIRECTORY, CACHE_FILE),
      lock: join(options.stateDir, CACHE_DIRECTORY, LOCK_DIRECTORY),
    }
    this.now = options.now ?? Date.now
    this.token = options.token ?? randomUUID
    this.incompleteGraceMs = Math.max(1, Math.floor(options.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS))
  }

  private currentTime() {
    const result = this.now()
    if (!Number.isFinite(result)) throw new SharedQuotaStoreError("Shared quota store clock returned an invalid time")
    return result
  }

  private nextToken() {
    const result = this.token()
    if (!SAFE_TOKEN.test(result)) throw new SharedQuotaStoreError("Shared quota store token is invalid")
    return result
  }

  private markerName(owner: string) {
    return `owner-${owner}.json`
  }

  private async ensureDirectory() {
    try {
      await mkdir(this.paths.directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new SharedQuotaStoreError(`Unable to create shared quota directory: ${message(error)}`, { cause: error })
    }
  }

  async read(): Promise<QuotaCache | undefined> {
    let raw: string
    try {
      raw = await readFile(this.paths.cache, "utf8")
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw new SharedQuotaStoreError(`Unable to read shared quota cache: ${message(error)}`, { cause: error })
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache is too large")
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache contains invalid JSON", { cause: error })
    }
    const source = record(parsed)
    if (source.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache has an unsupported schema version")
    }
    return quotaCache({
      reports: source.reports,
      updatedAt: source.updatedAt,
      checkedAt: source.checkedAt,
      retryAt: source.retryAt,
      failures: source.failures,
      error: source.error,
    })
  }

  private async readMarker(name: string): Promise<MarkerSnapshot | undefined> {
    if (!name.startsWith("owner-") || !name.endsWith(".json")) return undefined
    const path = join(this.paths.lock, name)
    let stat: Stats
    let raw: string
    try {
      stat = await lstat(path)
      if (!stat.isFile()) return undefined
      if (stat.size > MAX_MARKER_BYTES) return undefined
      raw = await readFile(path, "utf8")
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_MARKER_BYTES) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    const source = record(parsed)
    const owner = string(source.owner)
    const ttlMs = number(source.ttlMs)
    if (
      source.schemaVersion !== CACHE_SCHEMA_VERSION ||
      !owner ||
      !SAFE_TOKEN.test(owner) ||
      this.markerName(owner) !== name ||
      ttlMs === undefined ||
      ttlMs <= 0
    ) {
      return undefined
    }
    return {
      name,
      path,
      marker: { schemaVersion: CACHE_SCHEMA_VERSION, owner, ttlMs },
      stat,
    }
  }

  private async lockEntries() {
    try {
      return await readdir(this.paths.lock, { withFileTypes: true })
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined
      throw error
    }
  }

  private async recoverStaleMarker(snapshot: MarkerSnapshot) {
    const entries = await this.lockEntries()
    if (!entries || entries.length !== 1 || entries[0]?.name !== snapshot.name) return false
    const current = await this.readMarker(snapshot.name)
    if (!current || current.marker.owner !== snapshot.marker.owner || !sameStat(current.stat, snapshot.stat)) return false
    if (this.currentTime() < current.stat.mtimeMs + current.marker.ttlMs) return false
    if (!(await safeUnlink(current.path))) return true
    return safeRmdir(this.paths.lock)
  }

  private async recoverIncompleteLock(entries: Awaited<ReturnType<SharedQuotaStore["lockEntries"]>>) {
    if (!entries) return true
    let directoryStat: Stats
    try {
      directoryStat = await lstat(this.paths.lock)
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true
      throw error
    }
    if (!directoryStat.isDirectory()) {
      throw new SharedQuotaStoreError("Shared quota lock path is not a directory")
    }

    const snapshots: Array<{ name: string; path: string; stat: Stats }> = []
    let newest = directoryStat.mtimeMs
    for (const entry of entries) {
      const path = join(this.paths.lock, entry.name)
      let stat: Stats
      try {
        stat = await lstat(path)
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false
        throw error
      }
      newest = Math.max(newest, stat.mtimeMs)
      snapshots.push({ name: entry.name, path, stat })
    }
    if (this.currentTime() < newest + this.incompleteGraceMs) return false
    if (snapshots.some((item) => !item.stat.isFile())) {
      throw new SharedQuotaStoreError("Shared quota lock contains an unsafe incomplete entry")
    }

    const latestEntries = await this.lockEntries()
    if (!latestEntries) return true
    const expectedNames = snapshots.map((item) => item.name).sort()
    const latestNames = latestEntries.map((item) => item.name).sort()
    if (expectedNames.length !== latestNames.length || expectedNames.some((name, index) => name !== latestNames[index])) {
      return false
    }
    for (const snapshot of snapshots) {
      let current: Stats
      try {
        current = await lstat(snapshot.path)
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false
        throw error
      }
      if (!sameStat(snapshot.stat, current)) return false
    }
    for (const snapshot of snapshots) {
      if (!(await safeUnlink(snapshot.path))) return false
    }
    return safeRmdir(this.paths.lock)
  }

  private async recoverExistingLock() {
    let directoryStat: Stats
    try {
      directoryStat = await lstat(this.paths.lock)
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true
      throw error
    }
    if (!directoryStat.isDirectory()) {
      throw new SharedQuotaStoreError("Shared quota lock path is not a directory")
    }
    const entries = await this.lockEntries()
    if (!entries) return true
    if (entries.length === 1) {
      const marker = await this.readMarker(entries[0]!.name)
      if (marker) {
        if (this.currentTime() < marker.stat.mtimeMs + marker.marker.ttlMs) return false
        return this.recoverStaleMarker(marker)
      }
    }
    return this.recoverIncompleteLock(entries)
  }

  async acquireLease(ttlMs: number): Promise<SharedQuotaLease | undefined> {
    const normalizedTTL = Math.floor(ttlMs)
    if (!Number.isFinite(normalizedTTL) || normalizedTTL <= 0) {
      throw new SharedQuotaStoreError("Shared quota lease TTL is invalid")
    }
    await this.ensureDirectory()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await mkdir(this.paths.lock, { mode: 0o700 })
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw new SharedQuotaStoreError(`Unable to acquire shared quota lock: ${message(error)}`, { cause: error })
        }
        try {
          if (await this.recoverExistingLock()) continue
          return undefined
        } catch (recoveryError) {
          if (recoveryError instanceof SharedQuotaStoreError) throw recoveryError
          throw new SharedQuotaStoreError(`Unable to inspect shared quota lock: ${message(recoveryError)}`, {
            cause: recoveryError,
          })
        }
      }

      const owner = this.nextToken()
      const markerPath = join(this.paths.lock, this.markerName(owner))
      try {
        await writeExclusiveSynced(
          markerPath,
          `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, owner, ttlMs: normalizedTTL })}\n`,
        )
        const now = new Date(this.currentTime())
        await utimes(markerPath, now, now)
      } catch (error) {
        try {
          await safeUnlink(markerPath)
          await safeRmdir(this.paths.lock)
        } catch {
          // A later stale-lock pass can safely finish cleanup.
        }
        throw new SharedQuotaStoreError(`Unable to create shared quota lease marker: ${message(error)}`, { cause: error })
      }
      const lease = new FileQuotaLease(this, owner)
      this.leases.add(lease)
      return lease
    }
    return undefined
  }

  private async ownedMarker(owner: string, allowExpired: boolean) {
    const expected = this.markerName(owner)
    const entries = await this.lockEntries()
    if (!entries || entries.length !== 1 || entries[0]?.name !== expected) return undefined
    const marker = await this.readMarker(expected)
    if (!marker) throw new SharedQuotaStoreError("Shared quota lease marker is invalid")
    if (marker.marker.owner !== owner) return undefined
    if (!allowExpired && this.currentTime() >= marker.stat.mtimeMs + marker.marker.ttlMs) return undefined
    return marker
  }

  async renewLease(owner: string) {
    const marker = await this.ownedMarker(owner, false)
    if (!marker) return false
    const now = new Date(this.currentTime())
    try {
      await utimes(marker.path, now, now)
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false
      throw new SharedQuotaStoreError(`Unable to renew shared quota lease: ${message(error)}`, { cause: error })
    }
    const confirmed = await this.ownedMarker(owner, false)
    return Boolean(confirmed)
  }

  async releaseLease(owner: string) {
    const marker = await this.ownedMarker(owner, true)
    if (!marker) return false
    const current = await this.readMarker(marker.name)
    if (!current || current.marker.owner !== owner || !sameStat(marker.stat, current.stat)) return false
    try {
      if (!(await safeUnlink(marker.path))) return false
      if (!(await safeRmdir(this.paths.lock))) {
        throw new SharedQuotaStoreError("Shared quota lock was not empty during release")
      }
      return true
    } catch (error) {
      if (error instanceof SharedQuotaStoreError) throw error
      throw new SharedQuotaStoreError(`Unable to release shared quota lease: ${message(error)}`, { cause: error })
    }
  }

  private async renameCache(tempPath: string) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tempPath, this.paths.cache)
        return
      } catch (error) {
        if (attempt >= 3 || !hasCode(error, "EACCES", "EBUSY", "EEXIST", "EPERM")) throw error
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
      }
    }
  }

  async write(value: QuotaCache, lease: SharedQuotaLease) {
    if (!this.leases.has(lease as object)) throw new LeaseLostError("Shared quota lease belongs to another store")
    await this.ensureDirectory()
    const payload = `${JSON.stringify(diskCache(value))}\n`
    let tempPath: string | undefined
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        this.tempSequence += 1
        const candidate = join(
          this.paths.directory,
          `.${CACHE_FILE}.${lease.owner}.${process.pid}.${this.tempSequence}.${this.nextToken()}.tmp`,
        )
        try {
          await writeExclusiveSynced(candidate, payload)
          tempPath = candidate
          break
        } catch (error) {
          if (!hasCode(error, "EEXIST")) {
            tempPath = candidate
            throw error
          }
        }
      }
      if (!tempPath) throw new SharedQuotaStoreError("Unable to allocate a unique shared quota cache temp file")
      if (!(await lease.renew())) throw new LeaseLostError()
      await this.renameCache(tempPath)
      tempPath = undefined
    } catch (error) {
      if (error instanceof SharedQuotaStoreError) throw error
      throw new SharedQuotaStoreError(`Unable to write shared quota cache: ${message(error)}`, { cause: error })
    } finally {
      if (tempPath) {
        try {
          await safeUnlink(tempPath)
        } catch {
          // The unique temp is ignored by readers and can be removed manually if cleanup fails.
        }
      }
    }
  }

  async initializeFromLegacy(value: unknown, ttlMs: number): Promise<MigrationResult> {
    const existing = await this.read()
    if (existing) return { cache: existing, migrated: false, busy: false }
    const legacy = quotaCache(value)
    const lease = await this.acquireLease(ttlMs)
    if (!lease) {
      const winner = await this.read()
      return { cache: winner, migrated: false, busy: !winner }
    }

    let result: MigrationResult | undefined
    let failure: unknown
    try {
      const winner = await this.read()
      if (winner) result = { cache: winner, migrated: false, busy: false }
      else {
        await this.write(legacy, lease)
        result = { cache: legacy, migrated: true, busy: false }
      }
    } catch (error) {
      failure = error
    }
    try {
      const released = await lease.release()
      if (!released && !failure) failure = new SharedQuotaStoreError("Shared quota migration lease was lost")
    } catch (error) {
      if (!failure) failure = error
    }
    if (failure) throw failure
    return result!
  }
}

export function createSharedQuotaStore(options: SharedQuotaStoreOptions) {
  return new SharedQuotaStore(options)
}
