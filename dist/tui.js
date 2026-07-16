// index.tsx
import { createMemo, createSignal, For, Show } from "solid-js";

// quota-time.ts
function number(value) {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : void 0;
}
function resetTimestamp(value, afterSeconds, now = Date.now()) {
  const after = number(afterSeconds);
  let target;
  if (after !== void 0) target = now + Math.max(0, after) * 1e3;
  if (target === void 0 && typeof value === "number") target = value > 1e10 ? value : value * 1e3;
  if (target === void 0 && typeof value === "string") {
    const numeric = Number(value);
    target = Number.isFinite(numeric) ? numeric > 1e10 ? numeric : numeric * 1e3 : Date.parse(value);
  }
  return target !== void 0 && Number.isFinite(target) ? target : void 0;
}
function compactDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return void 0;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}
function compactTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return void 0;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// refresh-schedule.ts
var TIMER_SLACK_MS = 250;
var MIN_REFRESH_MS = 6e4;
function clampRefreshMs(value) {
  return Math.max(MIN_REFRESH_MS, value);
}
function shouldPollAutomatically(autoMode, pollInAutoMode) {
  return !autoMode || pollInAutoMode;
}
function sharedCacheDisplayStatus(input) {
  if (input.configuredStatus !== input.readyStatus) return input.configuredStatus;
  return input.error && input.reportCount === 0 ? input.errorStatus : input.readyStatus;
}
function selectMissingCacheFallback(input) {
  return input.migrationPending ? input.legacy : input.latest;
}
function snapshotSlotState(state, refreshing) {
  return {
    state: state(),
    refreshing: refreshing()
  };
}
function nextRefreshDelay(checkedAt, refreshMs, now) {
  return Math.min(
    refreshMs + TIMER_SLACK_MS,
    Math.max(TIMER_SLACK_MS, checkedAt + refreshMs + TIMER_SLACK_MS - now)
  );
}
function dueProviderRefreshes(input) {
  return input.kinds.filter((kind) => {
    const refresh = input.refresh[kind];
    if (refresh?.retryAt !== void 0) return refresh.retryAt <= input.now;
    if (input.force) return true;
    return refresh?.checkedAt === void 0 || input.now - refresh.checkedAt >= input.refreshMs;
  });
}
function nextProviderRefreshDelay(input) {
  if (!input.kinds.length) return TIMER_SLACK_MS;
  return Math.min(
    ...input.kinds.map((kind) => {
      const refresh = input.refresh[kind];
      if (refresh?.retryAt !== void 0) {
        return Math.max(TIMER_SLACK_MS, refresh.retryAt - input.now + TIMER_SLACK_MS);
      }
      if (refresh?.checkedAt === void 0) return TIMER_SLACK_MS;
      return Math.min(
        input.refreshMs + TIMER_SLACK_MS,
        Math.max(TIMER_SLACK_MS, refresh.checkedAt + input.refreshMs + TIMER_SLACK_MS - input.now)
      );
    })
  );
}
function latestRefreshAt(values) {
  const timestamps = values.filter((value) => value !== void 0 && Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : void 0;
}
function shouldAdoptCache(input) {
  if (!input.cacheHasReports) return false;
  if (!input.currentHasReports) return true;
  return (input.cacheVersion ?? Number.NEGATIVE_INFINITY) > (input.currentVersion ?? Number.NEGATIVE_INFINITY);
}

// shared-quota-store.ts
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
var CACHE_SCHEMA_VERSION = 1;
var CACHE_DIRECTORY = "cpa-quota-sidebar";
var CACHE_FILE = "cache.v1.json";
var LOCK_DIRECTORY = "refresh.v1.lock";
var DEFAULT_INCOMPLETE_GRACE_MS = 2e3;
var MAX_CACHE_BYTES = 1e6;
var MAX_MARKER_BYTES = 4096;
var SAFE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
var MAX_CACHE_ERROR_LENGTH = 500;
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function number2(value) {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : void 0;
}
function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function cacheError(value) {
  const result = string(value);
  if (!result) return void 0;
  const normalized = result.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized.slice(0, MAX_CACHE_ERROR_LENGTH).trimEnd() || void 0;
}
function providerKind(value) {
  return value === "codex" || value === "claude" || value === "grok" ? value : void 0;
}
function quotaWindow(value) {
  const source = record(value);
  const id = string(source.id);
  const label = string(source.label);
  const used = number2(source.used);
  if (!id || !label || used === void 0) return void 0;
  const resetAt = number2(source.resetAt);
  return {
    id,
    label,
    used: Math.min(100, Math.max(0, used)),
    ...resetAt === void 0 ? {} : { resetAt }
  };
}
function quotaReport(value) {
  const source = record(value);
  const kind = providerKind(source.kind);
  const account = string(source.account);
  if (!kind || !account) return void 0;
  const plan = string(source.plan);
  const error = string(source.error);
  const windows = Array.isArray(source.windows) ? source.windows.map(quotaWindow).filter((item) => Boolean(item)) : [];
  return {
    kind,
    account,
    ...plan ? { plan } : {},
    windows,
    ...error ? { error } : {}
  };
}
function providerRefresh(value) {
  const source = record(value);
  const checkedAt = number2(source.checkedAt);
  const retryAt = number2(source.retryAt);
  const failures = Math.max(0, Math.floor(number2(source.failures) ?? 0));
  if (checkedAt === void 0 && retryAt === void 0 && failures === 0) return void 0;
  return {
    ...checkedAt === void 0 ? {} : { checkedAt },
    ...retryAt === void 0 ? {} : { retryAt },
    failures
  };
}
function providerRefreshState(value) {
  const source = record(value);
  const result = {};
  for (const kind of ["codex", "claude", "grok"]) {
    const refresh = providerRefresh(source[kind]);
    if (refresh) result[kind] = refresh;
  }
  return Object.keys(result).length ? result : void 0;
}
function quotaCache(value) {
  const source = record(value);
  const reports = Array.isArray(source.reports) ? source.reports.map(quotaReport).filter((item) => Boolean(item)) : [];
  const updatedAt = number2(source.updatedAt);
  const checkedAt = number2(source.checkedAt);
  const retryAt = number2(source.retryAt);
  const failures = Math.max(0, Math.floor(number2(source.failures) ?? 0));
  const providerRefresh2 = providerRefreshState(source.providerRefresh);
  const error = cacheError(source.error);
  return {
    reports,
    ...updatedAt === void 0 ? {} : { updatedAt },
    ...checkedAt === void 0 ? {} : { checkedAt },
    ...retryAt === void 0 ? {} : { retryAt },
    failures,
    ...providerRefresh2 ? { providerRefresh: providerRefresh2 } : {},
    ...error ? { error } : {}
  };
}
function diskCache(value) {
  const cache = quotaCache(value);
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    reports: cache.reports,
    ...cache.updatedAt === void 0 ? {} : { updatedAt: cache.updatedAt },
    ...cache.checkedAt === void 0 ? {} : { checkedAt: cache.checkedAt },
    ...cache.retryAt === void 0 ? {} : { retryAt: cache.retryAt },
    failures: cache.failures,
    ...cache.providerRefresh ? { providerRefresh: cache.providerRefresh } : {},
    ...cache.error ? { error: cache.error } : {}
  };
}
function errorCode(error) {
  return record(error).code;
}
function hasCode(error, ...codes) {
  const code = errorCode(error);
  return typeof code === "string" && codes.includes(code);
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
async function writeExclusiveSynced(path, value) {
  const handle = await open(path, "wx", 384);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function safeUnlink(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}
async function safeRmdir(path) {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    if (hasCode(error, "ENOTEMPTY", "EEXIST")) return false;
    throw error;
  }
}
var SharedQuotaStoreError = class extends Error {
  constructor(message2, options) {
    super(message2, options);
    this.name = "SharedQuotaStoreError";
  }
};
var InvalidSharedQuotaCacheError = class extends SharedQuotaStoreError {
  constructor(message2, options) {
    super(message2, options);
    this.name = "InvalidSharedQuotaCacheError";
  }
};
var LeaseLostError = class extends SharedQuotaStoreError {
  constructor(message2 = "Shared quota refresh lease was lost") {
    super(message2);
    this.name = "LeaseLostError";
  }
};
var FileQuotaLease = class {
  constructor(store, owner) {
    this.store = store;
    this.owner = owner;
  }
  #released = false;
  async renew() {
    if (this.#released) return false;
    const renewed = await this.store.renewLease(this.owner);
    if (!renewed) this.#released = true;
    return renewed;
  }
  async release() {
    if (this.#released) return false;
    const released = await this.store.releaseLease(this.owner);
    this.#released = true;
    return released;
  }
};
var SharedQuotaStore = class {
  paths;
  now;
  token;
  incompleteGraceMs;
  leases = /* @__PURE__ */ new WeakSet();
  tempSequence = 0;
  constructor(options) {
    if (!string(options.stateDir)) throw new SharedQuotaStoreError("OpenCode state directory is unavailable");
    this.paths = {
      directory: join(options.stateDir, CACHE_DIRECTORY),
      cache: join(options.stateDir, CACHE_DIRECTORY, CACHE_FILE),
      lock: join(options.stateDir, CACHE_DIRECTORY, LOCK_DIRECTORY)
    };
    this.now = options.now ?? Date.now;
    this.token = options.token ?? randomUUID;
    this.incompleteGraceMs = Math.max(1, Math.floor(options.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS));
  }
  currentTime() {
    const result = this.now();
    if (!Number.isFinite(result)) throw new SharedQuotaStoreError("Shared quota store clock returned an invalid time");
    return result;
  }
  nextToken() {
    const result = this.token();
    if (!SAFE_TOKEN.test(result)) throw new SharedQuotaStoreError("Shared quota store token is invalid");
    return result;
  }
  markerName(owner) {
    return `owner-${owner}.json`;
  }
  async ensureDirectory() {
    try {
      await mkdir(this.paths.directory, { recursive: true, mode: 448 });
    } catch (error) {
      throw new SharedQuotaStoreError(`Unable to create shared quota directory: ${message(error)}`, { cause: error });
    }
  }
  async read() {
    let raw;
    try {
      raw = await readFile(this.paths.cache, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return void 0;
      throw new SharedQuotaStoreError(`Unable to read shared quota cache: ${message(error)}`, { cause: error });
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache is too large");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache contains invalid JSON", { cause: error });
    }
    const source = record(parsed);
    if (source.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new InvalidSharedQuotaCacheError("Shared quota cache has an unsupported schema version");
    }
    return quotaCache({
      reports: source.reports,
      updatedAt: source.updatedAt,
      checkedAt: source.checkedAt,
      retryAt: source.retryAt,
      failures: source.failures,
      providerRefresh: source.providerRefresh,
      error: source.error
    });
  }
  async readMarker(name) {
    if (!name.startsWith("owner-") || !name.endsWith(".json")) return void 0;
    const path = join(this.paths.lock, name);
    let stat;
    let raw;
    try {
      stat = await lstat(path);
      if (!stat.isFile()) return void 0;
      if (stat.size > MAX_MARKER_BYTES) return void 0;
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return void 0;
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_MARKER_BYTES) return void 0;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return void 0;
    }
    const source = record(parsed);
    const owner = string(source.owner);
    const ttlMs = number2(source.ttlMs);
    if (source.schemaVersion !== CACHE_SCHEMA_VERSION || !owner || !SAFE_TOKEN.test(owner) || this.markerName(owner) !== name || ttlMs === void 0 || ttlMs <= 0) {
      return void 0;
    }
    return {
      name,
      path,
      marker: { schemaVersion: CACHE_SCHEMA_VERSION, owner, ttlMs },
      stat
    };
  }
  async lockEntries() {
    try {
      return await readdir(this.paths.lock, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return void 0;
      throw error;
    }
  }
  async recoverStaleMarker(snapshot) {
    const entries = await this.lockEntries();
    if (!entries || entries.length !== 1 || entries[0]?.name !== snapshot.name) return false;
    const current = await this.readMarker(snapshot.name);
    if (!current || current.marker.owner !== snapshot.marker.owner || !sameStat(current.stat, snapshot.stat)) return false;
    if (this.currentTime() < current.stat.mtimeMs + current.marker.ttlMs) return false;
    if (!await safeUnlink(current.path)) return true;
    return safeRmdir(this.paths.lock);
  }
  async recoverIncompleteLock(entries) {
    if (!entries) return true;
    let directoryStat;
    try {
      directoryStat = await lstat(this.paths.lock);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      throw error;
    }
    if (!directoryStat.isDirectory()) {
      throw new SharedQuotaStoreError("Shared quota lock path is not a directory");
    }
    const snapshots = [];
    let newest = directoryStat.mtimeMs;
    for (const entry of entries) {
      const path = join(this.paths.lock, entry.name);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
      newest = Math.max(newest, stat.mtimeMs);
      snapshots.push({ name: entry.name, path, stat });
    }
    if (this.currentTime() < newest + this.incompleteGraceMs) return false;
    if (snapshots.some((item) => !item.stat.isFile())) {
      throw new SharedQuotaStoreError("Shared quota lock contains an unsafe incomplete entry");
    }
    const latestEntries = await this.lockEntries();
    if (!latestEntries) return true;
    const expectedNames = snapshots.map((item) => item.name).sort();
    const latestNames = latestEntries.map((item) => item.name).sort();
    if (expectedNames.length !== latestNames.length || expectedNames.some((name, index) => name !== latestNames[index])) {
      return false;
    }
    for (const snapshot of snapshots) {
      let current;
      try {
        current = await lstat(snapshot.path);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
      if (!sameStat(snapshot.stat, current)) return false;
    }
    for (const snapshot of snapshots) {
      if (!await safeUnlink(snapshot.path)) return false;
    }
    return safeRmdir(this.paths.lock);
  }
  async recoverExistingLock() {
    let directoryStat;
    try {
      directoryStat = await lstat(this.paths.lock);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      throw error;
    }
    if (!directoryStat.isDirectory()) {
      throw new SharedQuotaStoreError("Shared quota lock path is not a directory");
    }
    const entries = await this.lockEntries();
    if (!entries) return true;
    if (entries.length === 1) {
      const marker = await this.readMarker(entries[0].name);
      if (marker) {
        if (this.currentTime() < marker.stat.mtimeMs + marker.marker.ttlMs) return false;
        return this.recoverStaleMarker(marker);
      }
    }
    return this.recoverIncompleteLock(entries);
  }
  async acquireLease(ttlMs) {
    const normalizedTTL = Math.floor(ttlMs);
    if (!Number.isFinite(normalizedTTL) || normalizedTTL <= 0) {
      throw new SharedQuotaStoreError("Shared quota lease TTL is invalid");
    }
    await this.ensureDirectory();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await mkdir(this.paths.lock, { mode: 448 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw new SharedQuotaStoreError(`Unable to acquire shared quota lock: ${message(error)}`, { cause: error });
        }
        try {
          if (await this.recoverExistingLock()) continue;
          return void 0;
        } catch (recoveryError) {
          if (recoveryError instanceof SharedQuotaStoreError) throw recoveryError;
          throw new SharedQuotaStoreError(`Unable to inspect shared quota lock: ${message(recoveryError)}`, {
            cause: recoveryError
          });
        }
      }
      const owner = this.nextToken();
      const markerPath = join(this.paths.lock, this.markerName(owner));
      try {
        await writeExclusiveSynced(
          markerPath,
          `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, owner, ttlMs: normalizedTTL })}
`
        );
        const now = new Date(this.currentTime());
        await utimes(markerPath, now, now);
      } catch (error) {
        try {
          await safeUnlink(markerPath);
          await safeRmdir(this.paths.lock);
        } catch {
        }
        throw new SharedQuotaStoreError(`Unable to create shared quota lease marker: ${message(error)}`, { cause: error });
      }
      const lease = new FileQuotaLease(this, owner);
      this.leases.add(lease);
      return lease;
    }
    return void 0;
  }
  async ownedMarker(owner, allowExpired) {
    const expected = this.markerName(owner);
    const entries = await this.lockEntries();
    if (!entries || entries.length !== 1 || entries[0]?.name !== expected) return void 0;
    const marker = await this.readMarker(expected);
    if (!marker) throw new SharedQuotaStoreError("Shared quota lease marker is invalid");
    if (marker.marker.owner !== owner) return void 0;
    if (!allowExpired && this.currentTime() >= marker.stat.mtimeMs + marker.marker.ttlMs) return void 0;
    return marker;
  }
  async renewLease(owner) {
    const marker = await this.ownedMarker(owner, false);
    if (!marker) return false;
    const now = new Date(this.currentTime());
    try {
      await utimes(marker.path, now, now);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw new SharedQuotaStoreError(`Unable to renew shared quota lease: ${message(error)}`, { cause: error });
    }
    const confirmed = await this.ownedMarker(owner, false);
    return Boolean(confirmed);
  }
  async releaseLease(owner) {
    const marker = await this.ownedMarker(owner, true);
    if (!marker) return false;
    const current = await this.readMarker(marker.name);
    if (!current || current.marker.owner !== owner || !sameStat(marker.stat, current.stat)) return false;
    try {
      if (!await safeUnlink(marker.path)) return false;
      if (!await safeRmdir(this.paths.lock)) {
        throw new SharedQuotaStoreError("Shared quota lock was not empty during release");
      }
      return true;
    } catch (error) {
      if (error instanceof SharedQuotaStoreError) throw error;
      throw new SharedQuotaStoreError(`Unable to release shared quota lease: ${message(error)}`, { cause: error });
    }
  }
  async renameCache(tempPath) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tempPath, this.paths.cache);
        return;
      } catch (error) {
        if (attempt >= 3 || !hasCode(error, "EACCES", "EBUSY", "EEXIST", "EPERM")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }
  async write(value, lease) {
    if (!this.leases.has(lease)) throw new LeaseLostError("Shared quota lease belongs to another store");
    await this.ensureDirectory();
    const payload = `${JSON.stringify(diskCache(value))}
`;
    let tempPath;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        this.tempSequence += 1;
        const candidate = join(
          this.paths.directory,
          `.${CACHE_FILE}.${lease.owner}.${process.pid}.${this.tempSequence}.${this.nextToken()}.tmp`
        );
        try {
          await writeExclusiveSynced(candidate, payload);
          tempPath = candidate;
          break;
        } catch (error) {
          if (!hasCode(error, "EEXIST")) {
            tempPath = candidate;
            throw error;
          }
        }
      }
      if (!tempPath) throw new SharedQuotaStoreError("Unable to allocate a unique shared quota cache temp file");
      if (!await lease.renew()) throw new LeaseLostError();
      await this.renameCache(tempPath);
      tempPath = void 0;
    } catch (error) {
      if (error instanceof SharedQuotaStoreError) throw error;
      throw new SharedQuotaStoreError(`Unable to write shared quota cache: ${message(error)}`, { cause: error });
    } finally {
      if (tempPath) {
        try {
          await safeUnlink(tempPath);
        } catch {
        }
      }
    }
  }
  async initializeFromLegacy(value, ttlMs) {
    const existing = await this.read();
    if (existing) return { cache: existing, migrated: false, busy: false };
    const legacy = quotaCache(value);
    const lease = await this.acquireLease(ttlMs);
    if (!lease) {
      const winner = await this.read();
      return { cache: winner, migrated: false, busy: !winner };
    }
    let result;
    let failure;
    try {
      const winner = await this.read();
      if (winner) result = { cache: winner, migrated: false, busy: false };
      else {
        await this.write(legacy, lease);
        result = { cache: legacy, migrated: true, busy: false };
      }
    } catch (error) {
      failure = error;
    }
    try {
      const released = await lease.release();
      if (!released && !failure) failure = new SharedQuotaStoreError("Shared quota migration lease was lost");
    } catch (error) {
      if (!failure) failure = error;
    }
    if (failure) throw failure;
    return result;
  }
};
function createSharedQuotaStore(options) {
  return new SharedQuotaStore(options);
}

// index.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var DEFAULT_REFRESH_MS = 6e5;
var DEFAULT_TIMEOUT_MS = 2e4;
var DEFAULT_BACKOFF_MS = 3e5;
var MAX_BACKOFF_MS = 36e5;
var LEGACY_CACHE_KEY = "cpa-quota-sidebar.cache.v2";
var SHARED_SYNC_MS = 5e3;
var STORAGE_RETRY_MS = 5e3;
var LOCK_RETRY_MS = 1e3;
var PROVIDER_KINDS = ["codex", "claude", "grok"];
var PROVIDER_ORDER = { codex: 0, claude: 1, grok: 2 };
var PLAN_KEYS = /* @__PURE__ */ new Set([
  "plan",
  "plan_type",
  "plantype",
  "plan_name",
  "planname",
  "account_plan",
  "accountplan",
  "billing_tier",
  "billingtier",
  "subscription_plan",
  "subscriptionplan",
  "subscription_type",
  "subscriptiontype",
  "subscription_tier",
  "subscriptiontier",
  "tier",
  "tier_name",
  "tiername"
]);
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function number3(value) {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : void 0;
}
function string2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function rateLimited(value) {
  return Boolean(value && /(?:429|rate[ -]?limit)/i.test(value));
}
function providerRefreshState2(cache) {
  const result = {};
  for (const kind of PROVIDER_KINDS) {
    const current = cache.providerRefresh?.[kind];
    if (current) {
      result[kind] = { ...current };
      continue;
    }
    const reports = cache.reports.filter((report) => report.kind === kind);
    if (!reports.length) continue;
    const limited = reports.some((report) => rateLimited(report.error));
    const checkedAt = cache.checkedAt ?? cache.updatedAt;
    result[kind] = {
      ...checkedAt === void 0 ? {} : { checkedAt },
      ...limited && cache.retryAt !== void 0 ? { retryAt: cache.retryAt } : {},
      failures: limited ? cache.failures : 0
    };
  }
  return result;
}
function trackedProviderKinds(cache, refresh = providerRefreshState2(cache)) {
  const kinds = new Set(cache.reports.map((report) => report.kind));
  for (const kind of PROVIDER_KINDS) {
    if (refresh[kind]) kinds.add(kind);
  }
  return PROVIDER_KINDS.filter((kind) => kinds.has(kind));
}
function cachedReport(report, previous) {
  const exact = previous.find((item) => item.kind === report.kind && item.account === report.account);
  if (exact?.windows.length) return exact;
  const sameKind = previous.filter((item) => item.kind === report.kind && item.windows.length);
  return sameKind.length === 1 ? sameKind[0] : void 0;
}
function mergeReports(reports, previous) {
  return reports.map((report) => {
    if (!report.error) return report;
    const cached = cachedReport(report, previous);
    return cached ? { ...cached, plan: report.plan ?? cached.plan, error: report.error } : report;
  });
}
function mergeRefreshedReports(reports, previous, refreshedKinds) {
  return [
    ...previous.filter((report) => !refreshedKinds.has(report.kind)),
    ...mergeReports(reports, previous)
  ];
}
function clampPercent(value) {
  const result = number3(value);
  if (result === void 0) return void 0;
  return Math.min(100, Math.max(0, result));
}
function boolFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(trimmed)) return true;
    if (["false", "0", "no", "n", "off"].includes(trimmed)) return false;
  }
  return void 0;
}
function normalizeBaseURL(value) {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}
function shortAccount(value) {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.length > 18 ? `${name.slice(0, 15)}\u2026` : name;
}
function providerKind2(file) {
  const value = [file.provider, file.type, file.name].filter(Boolean).join(" ").toLowerCase();
  if (value.includes("codex") || value.includes("openai")) return "codex";
  if (value.includes("claude") || value.includes("anthropic")) return "claude";
  if (value.includes("grok") || value.includes("xai")) return "grok";
  return void 0;
}
function providerTitle(kind) {
  if (kind === "codex") return "Codex";
  if (kind === "claude") return "Claude";
  return "Grok";
}
function accountLabel(file) {
  const source = record2(file);
  const metadata = record2(source.metadata);
  return shortAccount(
    string2(source.email) ?? string2(metadata.email) ?? string2(source.account) ?? string2(source.name) ?? providerTitle(providerKind2(file) ?? "codex")
  );
}
function decodeJWT(value) {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value !== "string") return void 0;
  const part = value.split(".")[1];
  if (!part) return void 0;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return record2(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return void 0;
  }
}
function findNestedString(value, keys, depth = 0) {
  if (depth > 7 || !value || typeof value !== "object") return void 0;
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const result = string2(item);
      if (result) return result;
    }
  }
  for (const item of Object.values(value)) {
    const result = findNestedString(item, keys, depth + 1);
    if (result) return result;
  }
  return void 0;
}
function findPlan(value, depth = 0) {
  if (depth > 7 || !value || typeof value !== "object") return void 0;
  for (const [key, item] of Object.entries(value)) {
    if (!PLAN_KEYS.has(key.toLowerCase())) continue;
    const direct = string2(item);
    if (direct) return direct;
    const nested = record2(item);
    const named = string2(nested.name) ?? string2(nested.label) ?? string2(nested.tier) ?? string2(nested.type);
    if (named) return named;
  }
  for (const item of Object.values(value)) {
    const result = findPlan(item, depth + 1);
    if (result) return result;
  }
  return void 0;
}
function planLabel(...values) {
  for (const value of values) {
    const result = findPlan(value);
    if (result) return result;
  }
  return void 0;
}
function displayPlan(kind, fetched, configured) {
  if (fetched) {
    if (kind === "codex" && fetched.toLowerCase() === "pro") return "Pro 20x";
    return fetched;
  }
  return string2(configured);
}
function chatGPTAccountID(file) {
  const direct = findNestedString(file, /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"]));
  if (direct) return direct;
  const source = record2(file);
  const metadata = record2(source.metadata);
  return findNestedString(decodeJWT(source.id_token), /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"])) ?? findNestedString(decodeJWT(metadata.id_token), /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"]));
}
function quotaColor(api, used) {
  if (used > 80) return api.theme.current.error;
  if (used > 50) return api.theme.current.warning;
  return api.theme.current.success;
}
function percentLabel(value) {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}
async function requestJSON(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function managementCall(input) {
  const envelope = await requestJSON(
    `${input.baseURL}/v0/management/api-call`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        auth_index: input.authIndex,
        method: input.method,
        url: input.url,
        header: input.headers,
        ...input.data === void 0 ? {} : { data: input.data }
      })
    },
    input.timeoutMs
  );
  const status = number3(envelope.status_code ?? envelope.statusCode) ?? 0;
  if (status < 200 || status >= 300) throw new Error(`upstream HTTP ${status || "error"}`);
  const raw = envelope.body;
  let body = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error("upstream returned invalid JSON");
    }
  }
  return { body: record2(body), headers: record2(envelope.header ?? envelope.headers) };
}
function authIndex(file) {
  const result = file.auth_index;
  if (typeof result === "number") return String(result);
  return string2(result);
}
function codexWindow(value, fallback) {
  const window = record2(value);
  const used = clampPercent(window.used_percent ?? window.usedPercent);
  if (used === void 0) return void 0;
  const seconds = number3(window.limit_window_seconds ?? window.limitWindowSeconds);
  const label = seconds && seconds >= 5e5 ? "7d" : seconds && seconds >= 14e3 ? "5h" : fallback;
  return {
    id: label,
    label,
    used,
    resetAt: resetTimestamp(window.reset_at ?? window.resetAt, window.reset_after_seconds ?? window.resetAfterSeconds)
  };
}
async function fetchCodex(file, baseURL, key, timeoutMs) {
  const index = authIndex(file);
  if (!index) throw new Error("missing auth index");
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "User-Agent": "codex_cli_rs/0.76.0 (cpa-quota-sidebar)",
    Accept: "application/json"
  };
  const accountID = chatGPTAccountID(file);
  if (accountID) headers["Chatgpt-Account-Id"] = accountID;
  const result = await managementCall({
    baseURL,
    key,
    authIndex: index,
    timeoutMs,
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers
  });
  const rate = record2(result.body.rate_limit ?? result.body.rateLimit);
  const windows = [codexWindow(rate.primary_window ?? rate.primaryWindow, "5h"), codexWindow(rate.secondary_window ?? rate.secondaryWindow, "7d")].filter(
    (item) => Boolean(item)
  );
  if (!windows.length) throw new Error("quota windows unavailable");
  return {
    kind: "codex",
    account: accountLabel(file),
    plan: string2(result.body.plan_type ?? result.body.planType) ?? planLabel(result.body, result.headers, file),
    windows
  };
}
function claudeWindow(body, id, label) {
  const value = record2(body[id]);
  const used = clampPercent(value.utilization ?? value.percent);
  if (used === void 0) return void 0;
  return { id, label, used, resetAt: resetTimestamp(value.resets_at ?? value.reset_at ?? value.resetsAt) };
}
function claudePlan(profile) {
  const account = record2(profile.account);
  const organization = record2(profile.organization);
  const rateLimitTier = string2(organization.rate_limit_tier ?? organization.rateLimitTier)?.toLowerCase();
  const hasMax = boolFlag(account.has_claude_max ?? account.hasClaudeMax);
  if (hasMax) {
    const multiplier = rateLimitTier?.match(/(\d+)x/)?.[1];
    return multiplier ? `Max ${multiplier}x` : "Max";
  }
  const hasPro = boolFlag(account.has_claude_pro ?? account.hasClaudePro);
  if (hasPro) return "Pro";
  const organizationType = string2(organization.organization_type ?? organization.organizationType)?.toLowerCase();
  const subscriptionStatus = string2(organization.subscription_status ?? organization.subscriptionStatus)?.toLowerCase();
  if (organizationType === "claude_team" && subscriptionStatus === "active") return "Team";
  if (hasMax === false && hasPro === false) return "Free";
  return void 0;
}
function grokPlan(monthlyBody) {
  const limit = number3(record2(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val);
  if (limit === 15e3) return "SuperGrok";
  if (limit === 15e4) return "SuperGrok Heavy";
  return void 0;
}
async function fetchClaude(file, baseURL, key, timeoutMs) {
  const index = authIndex(file);
  if (!index) throw new Error("missing auth index");
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20"
  };
  const [usage, profile] = await Promise.allSettled([
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      headers
    }),
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/profile",
      headers
    })
  ]);
  if (usage.status === "rejected") throw usage.reason;
  const result = usage.value;
  const windows = [
    claudeWindow(result.body, "five_hour", "5h"),
    claudeWindow(result.body, "seven_day", "7d"),
    claudeWindow(result.body, "seven_day_sonnet", "Sonnet 7d"),
    claudeWindow(result.body, "seven_day_opus", "Opus 7d")
  ].filter((item) => Boolean(item));
  if (!windows.length) throw new Error("quota windows unavailable");
  const plan = (profile.status === "fulfilled" ? claudePlan(profile.value.body) : void 0) ?? planLabel(result.body, result.headers, file);
  return {
    kind: "claude",
    account: accountLabel(file),
    plan,
    windows
  };
}
async function fetchGrok(file, baseURL, key, timeoutMs) {
  const index = authIndex(file);
  if (!index) throw new Error("missing auth index");
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.91",
    Accept: "*/*",
    "User-Agent": "grok-pager/0.2.91 grok-shell/0.2.91 (cpa-quota-sidebar)"
  };
  const [weekly, monthly] = await Promise.allSettled([
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      headers
    }),
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing",
      headers
    })
  ]);
  if (weekly.status === "rejected" && monthly.status === "rejected") throw new Error("billing endpoint unavailable");
  const weeklyBody = weekly.status === "fulfilled" ? record2(weekly.value.body.config ?? weekly.value.body) : {};
  const monthlyBody = monthly.status === "fulfilled" ? record2(monthly.value.body.config ?? monthly.value.body) : {};
  const windows = [];
  const weeklyUsed = clampPercent(weeklyBody.creditUsagePercent ?? weeklyBody.credit_usage_percent);
  const period = record2(weeklyBody.currentPeriod ?? weeklyBody.current_period);
  const periodType = string2(period.type)?.toLowerCase() ?? "";
  const products = Array.isArray(weeklyBody.productUsage ?? weeklyBody.product_usage) ? weeklyBody.productUsage ?? weeklyBody.product_usage : [];
  if (weeklyUsed !== void 0) {
    windows.push({ id: "weekly", label: "Week", used: weeklyUsed, resetAt: resetTimestamp(period.end) });
  } else if (periodType.includes("weekly") && !products.length) {
    windows.push({ id: "weekly", label: "Week", used: 0, resetAt: resetTimestamp(period.end) });
  }
  for (const raw of products.slice(0, 2)) {
    const product = record2(raw);
    const used = clampPercent(product.usagePercent ?? product.usage_percent);
    if (used === void 0) continue;
    const name = string2(product.product) ?? "Product";
    windows.push({ id: `product-${name}`, label: name, used, resetAt: resetTimestamp(period.end) });
  }
  const limit = number3(record2(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val);
  const usedCredits = number3(record2(monthlyBody.used).val);
  if (limit && usedCredits !== void 0) {
    windows.push({
      id: "monthly",
      label: "Month",
      used: Math.min(100, Math.max(0, usedCredits / limit * 100)),
      resetAt: resetTimestamp(monthlyBody.billingPeriodEnd ?? monthlyBody.billing_period_end)
    });
  }
  if (!windows.length) throw new Error("quota windows unavailable");
  const plan = grokPlan(monthlyBody) ?? planLabel(
    weeklyBody,
    monthlyBody,
    weekly.status === "fulfilled" ? weekly.value.headers : void 0,
    monthly.status === "fulfilled" ? monthly.value.headers : void 0,
    file
  );
  return {
    kind: "grok",
    account: accountLabel(file),
    plan,
    windows
  };
}
async function fetchReports(baseURL, key, timeoutMs, kinds) {
  const auth = await requestJSON(
    `${baseURL}/v0/management/auth-files`,
    { headers: { Authorization: `Bearer ${key}` } },
    timeoutMs
  );
  const files = Array.isArray(auth.files) ? auth.files : [];
  const supported = files.map((file) => ({ file, kind: providerKind2(file) })).filter((item) => item.kind);
  if (!supported.length) throw new Error("no supported CPA auth files");
  const selected = kinds ? supported.filter(({ kind }) => kind && kinds.has(kind)) : supported;
  const reports = await Promise.all(
    selected.map(async ({ file, kind }) => {
      try {
        if (kind === "codex") return await fetchCodex(file, baseURL, key, timeoutMs);
        if (kind === "claude") return await fetchClaude(file, baseURL, key, timeoutMs);
        return await fetchGrok(file, baseURL, key, timeoutMs);
      } catch (error) {
        return {
          kind,
          account: accountLabel(file),
          windows: [],
          error: error instanceof Error ? error.message : "quota request failed"
        };
      }
    })
  );
  return {
    reports,
    supportedKinds: new Set(supported.map(({ kind }) => kind))
  };
}
function QuotaView(props) {
  const reports = createMemo(
    () => [...props.state.reports].sort(
      (left, right) => PROVIDER_ORDER[left.kind] - PROVIDER_ORDER[right.kind] || left.account.localeCompare(right.account)
    )
  );
  const checked = createMemo(() => {
    const value = props.state.checkedAt ?? props.state.updatedAt;
    if (!value) return void 0;
    return compactTime(value);
  });
  const reportError = (report) => {
    if (!report.error) return void 0;
    const error = report.error.replace(/\s*·\s*retry\s+.*$/i, "");
    const retryAt = props.state.providerRefresh?.[report.kind]?.retryAt;
    if (!rateLimited(error) || retryAt === void 0) return error;
    const retry = compactTime(retryAt);
    return retry ? `${error} \xB7 retry ${retry}` : error;
  };
  return /* @__PURE__ */ jsxs("box", { width: "100%", children: [
    /* @__PURE__ */ jsxs("box", { width: "100%", flexDirection: "row", justifyContent: "space-between", marginBottom: 1, children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.text, children: /* @__PURE__ */ jsx("b", { children: "Quota" }) }),
      /* @__PURE__ */ jsxs("box", { flexDirection: "row", alignItems: "center", gap: 1, children: [
        /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: props.refreshing ? "refreshing" : checked() }),
        /* @__PURE__ */ jsx(
          "box",
          {
            height: 1,
            paddingX: 1,
            backgroundColor: props.api.theme.current.backgroundElement,
            onMouseDown: () => void props.refresh(true),
            children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.primary, children: "\u21BB" })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Show, { when: props.state.status === "missing-key", children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: "Set managementKey in tui.json" }),
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "then restart OpenCode" })
    ] }),
    /* @__PURE__ */ jsxs(Show, { when: props.state.status === "missing-base-url", children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: "Set baseURL in tui.json" }),
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "then restart OpenCode" })
    ] }),
    /* @__PURE__ */ jsx(Show, { when: props.state.status === "loading" && !props.state.reports.length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "Loading subscription usage\u2026" }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state.status === "error" && !props.state.reports.length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.error, children: props.state.error ?? "Quota unavailable" }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state.error && !props.state.reports.length && props.state.status !== "error", children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.error, children: props.state.error }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state.error && props.state.reports.length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: props.state.error }) }),
    /* @__PURE__ */ jsx("box", { width: "100%", gap: 1, children: /* @__PURE__ */ jsx(For, { each: reports(), children: (report) => /* @__PURE__ */ jsxs("box", { width: "100%", children: [
      /* @__PURE__ */ jsxs("box", { width: "100%", flexDirection: "row", justifyContent: "space-between", children: [
        /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.text, children: /* @__PURE__ */ jsx("b", { children: providerTitle(report.kind) }) }),
        /* @__PURE__ */ jsx(Show, { when: report.plan, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: report.plan }) })
      ] }),
      /* @__PURE__ */ jsx(Show, { when: reportError(report), children: (error) => /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: error() }) }),
      /* @__PURE__ */ jsx(For, { each: report.windows, children: (window) => {
        const color = () => quotaColor(props.api, window.used);
        const reset = () => window.resetAt === void 0 ? void 0 : compactDate(window.resetAt);
        return /* @__PURE__ */ jsxs("box", { width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between", children: [
          /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: window.label }),
          /* @__PURE__ */ jsxs("box", { flexDirection: "row", children: [
            /* @__PURE__ */ jsx("text", { fg: color(), children: /* @__PURE__ */ jsx("b", { children: percentLabel(window.used) }) }),
            /* @__PURE__ */ jsx(Show, { when: reset(), children: (label) => /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
              " | ",
              label()
            ] }) })
          ] })
        ] });
      } })
    ] }) }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state.status === "ready" && !reports().length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "No supported quota accounts" }) })
  ] });
}
var tui = async (api, rawOptions) => {
  const autoMode = process.argv.includes("--auto");
  const options = rawOptions ?? {};
  const rawBaseURL = string2(options.baseURL);
  const baseURL = rawBaseURL ? normalizeBaseURL(rawBaseURL) : void 0;
  const refreshMs = clampRefreshMs(number3(options.refreshMs) ?? DEFAULT_REFRESH_MS);
  const timeoutMs = Math.max(5e3, number3(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS);
  const backoffMs = Math.max(6e4, number3(options.backoffMs) ?? DEFAULT_BACKOFF_MS);
  const leaseMs = timeoutMs * 2 + 15e3;
  const automaticPolling = shouldPollAutomatically(autoMode, options.pollInAutoMode === true);
  const key = string2(options.managementKey);
  const planLabels = record2(options.planLabels);
  const store = createSharedQuotaStore({ stateDir: api.state.path.state });
  const legacyValue = api.kv.get(LEGACY_CACHE_KEY, {});
  const legacyCache = quotaCache(legacyValue);
  let initialCache = quotaCache({});
  let initialStorageError;
  let migrationPending = true;
  try {
    const initial = await store.initializeFromLegacy(legacyValue, leaseMs);
    initialCache = initial.cache ?? initialCache;
    migrationPending = initial.busy && !initial.cache;
  } catch (error) {
    initialStorageError = error instanceof Error ? error.message : "Shared quota cache initialization failed";
    migrationPending = !(error instanceof InvalidSharedQuotaCacheError);
  }
  const configuredStatus = () => !baseURL ? "missing-base-url" : !key ? "missing-key" : "ready";
  const cacheVersion = (cache) => {
    const providerChecks = Object.values(cache.providerRefresh ?? {}).map((refresh2) => refresh2?.checkedAt);
    return latestRefreshAt([cache.updatedAt, cache.checkedAt, ...providerChecks]);
  };
  const stateFromCache = (cache, options2 = {}) => {
    const error = options2.error ?? cache.error;
    const configured = configuredStatus();
    const loading = configured === "ready" && options2.loadingWhenEmpty === true && !error && cache.reports.length === 0 && cacheVersion(cache) === void 0;
    const status = loading ? "loading" : sharedCacheDisplayStatus({
      configuredStatus: configured,
      readyStatus: "ready",
      errorStatus: "error",
      reportCount: cache.reports.length,
      error
    });
    return {
      status,
      reports: cache.reports,
      updatedAt: cache.updatedAt,
      checkedAt: cacheVersion(cache),
      providerRefresh: cache.providerRefresh,
      error
    };
  };
  let latestCache = initialCache;
  const [state, setState] = createSignal(
    stateFromCache(initialCache, { error: initialStorageError, loadingWhenEmpty: true })
  );
  const [refreshing, setRefreshing] = createSignal(false);
  let inflight;
  let scheduled;
  let refresh;
  let storageErrorActive = Boolean(initialStorageError);
  let storageProbeRequired = Boolean(initialStorageError);
  const scheduleRefresh = (delay) => {
    if (api.lifecycle.signal.aborted) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = void 0;
      void refresh(false);
    }, Math.max(TIMER_SLACK_MS, delay));
  };
  const adoptCache = (cache) => {
    const current = state();
    const currentVersion = current.checkedAt ?? current.updatedAt;
    const sharedVersion = cacheVersion(cache);
    let adopted;
    if (shouldAdoptCache({
      currentHasReports: current.reports.length > 0,
      currentVersion,
      cacheHasReports: cache.reports.length > 0,
      cacheVersion: sharedVersion
    })) {
      adopted = cache;
    } else if (sharedVersion !== void 0 && sharedVersion > (currentVersion ?? Number.NEGATIVE_INFINITY) || currentVersion === void 0 && Boolean(cache.error)) {
      adopted = quotaCache({
        reports: cache.reports.length ? cache.reports : current.reports,
        updatedAt: cache.updatedAt ?? current.updatedAt,
        checkedAt: cache.checkedAt ?? current.checkedAt,
        retryAt: cache.retryAt,
        failures: cache.failures,
        providerRefresh: cache.providerRefresh ?? latestCache.providerRefresh,
        error: cache.error
      });
    }
    if (adopted) {
      latestCache = adopted;
      setState(stateFromCache(adopted, { error: storageErrorActive ? current.error : adopted.error }));
    }
    return latestCache;
  };
  const retryLabel = (timestamp) => compactTime(timestamp) ?? "later";
  const backoffDelay = (failures) => Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** Math.min(8, Math.max(0, failures - 1)));
  const refreshTargets = (cache, now, force) => {
    const providerRefresh2 = providerRefreshState2(cache);
    const kinds = trackedProviderKinds(cache, providerRefresh2);
    if (!kinds.length) return void 0;
    return new Set(
      dueProviderRefreshes({
        kinds,
        refresh: providerRefresh2,
        refreshMs,
        now,
        force
      })
    );
  };
  const targetsAdvanced = (before, after, targets) => {
    if (!targets) {
      return (cacheVersion(after) ?? Number.NEGATIVE_INFINITY) > (cacheVersion(before) ?? Number.NEGATIVE_INFINITY);
    }
    if (targets.size === 0) return false;
    const beforeRefresh = providerRefreshState2(before);
    const afterRefresh = providerRefreshState2(after);
    return [...targets].every(
      (kind) => (afterRefresh[kind]?.checkedAt ?? Number.NEGATIVE_INFINITY) > (beforeRefresh[kind]?.checkedAt ?? Number.NEGATIVE_INFINITY)
    );
  };
  const scheduleFromCache = (cache, now = Date.now()) => {
    if (!automaticPolling) {
      scheduleRefresh(SHARED_SYNC_MS);
      return;
    }
    const providerRefresh2 = providerRefreshState2(cache);
    const kinds = trackedProviderKinds(cache, providerRefresh2);
    if (kinds.length) {
      scheduleRefresh(
        Math.min(
          SHARED_SYNC_MS,
          nextProviderRefreshDelay({ kinds, refresh: providerRefresh2, refreshMs, now })
        )
      );
      return;
    }
    if (cache.retryAt && cache.retryAt > now) {
      scheduleRefresh(Math.min(SHARED_SYNC_MS, cache.retryAt - now + TIMER_SLACK_MS));
      return;
    }
    const checkedAt = cacheVersion(cache);
    if (checkedAt && now - checkedAt < refreshMs) {
      scheduleRefresh(Math.min(SHARED_SYNC_MS, nextRefreshDelay(checkedAt, refreshMs, now)));
      return;
    }
    scheduleRefresh(TIMER_SLACK_MS);
  };
  const markStorageError = (error, notify) => {
    const message2 = error instanceof Error ? error.message : "Shared quota storage failed";
    storageErrorActive = true;
    storageProbeRequired = true;
    setState((previous) => ({
      ...previous,
      status: previous.status === "missing-base-url" || previous.status === "missing-key" ? previous.status : previous.reports.length ? "ready" : "error",
      error: message2
    }));
    scheduleRefresh(STORAGE_RETRY_MS);
    if (notify) api.ui.toast({ variant: "error", title: "CPA quota", message: message2 });
  };
  const clearStorageError = () => {
    if (!storageErrorActive) return;
    storageErrorActive = false;
    setState(stateFromCache(latestCache, { loadingWhenEmpty: true }));
  };
  const showRetryToast = (cache, now = Date.now()) => {
    const providerRefresh2 = providerRefreshState2(cache);
    const retries = trackedProviderKinds(cache, providerRefresh2).map((kind) => ({ kind, retryAt: providerRefresh2[kind]?.retryAt })).filter((item) => Boolean(item.retryAt && item.retryAt > now));
    const message2 = retries.length ? retries.map(({ kind, retryAt }) => `${providerTitle(kind)} ${retryLabel(retryAt)}`).join(" \xB7 ") : cache.retryAt && cache.retryAt > now ? retryLabel(cache.retryAt) : "later";
    api.ui.toast({
      variant: "warning",
      title: "CPA quota",
      message: `Rate limited; retry ${message2}`
    });
  };
  const adoptAfterLeaseLoss = async (notify) => {
    try {
      const latest = await store.read();
      if (latest) {
        migrationPending = false;
        adoptCache(latest);
      }
    } catch (error) {
      markStorageError(error, notify);
      return;
    }
    scheduleRefresh(LOCK_RETRY_MS);
    if (notify) {
      api.ui.toast({
        variant: "warning",
        title: "CPA quota",
        message: "Another OpenCode process owns the quota refresh; waiting for its shared result"
      });
    }
  };
  refresh = async (notify = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      let cache = latestCache;
      let sharedMissing = false;
      try {
        const shared = await store.read();
        if (shared) {
          migrationPending = false;
          cache = adoptCache(shared);
        } else sharedMissing = true;
      } catch (error) {
        markStorageError(error, notify);
        cache = latestCache;
      }
      const allowUpstream = notify || automaticPolling;
      const needsCoordination = storageProbeRequired || migrationPending || sharedMissing;
      const beforeLockCache = cache;
      const now = Date.now();
      const beforeTargets = refreshTargets(cache, now, notify);
      if (!needsCoordination) {
        if (!baseURL || !key) {
          setState((previous) => ({ ...previous, status: configuredStatus() }));
          scheduleRefresh(SHARED_SYNC_MS);
          return;
        }
        if (!allowUpstream) {
          scheduleRefresh(SHARED_SYNC_MS);
          return;
        }
        if (!beforeTargets && cache.retryAt && cache.retryAt > now) {
          scheduleFromCache(cache, now);
          if (notify) showRetryToast(cache, now);
          return;
        }
        const lastCheck = cacheVersion(cache);
        if (!beforeTargets && !notify && lastCheck && now - lastCheck < refreshMs) {
          scheduleFromCache(cache, now);
          return;
        }
        if (beforeTargets?.size === 0) {
          scheduleFromCache(cache, now);
          if (notify) showRetryToast(cache, now);
          return;
        }
      }
      let lease;
      let leaseLost = false;
      let didSetRefreshing = false;
      try {
        try {
          lease = await store.acquireLease(leaseMs);
        } catch (error) {
          markStorageError(error, notify);
          return;
        }
        if (!lease) {
          scheduleRefresh(LOCK_RETRY_MS);
          if (notify) {
            api.ui.toast({
              variant: "warning",
              title: "CPA quota",
              message: "Another OpenCode process is refreshing quota usage"
            });
          }
          return;
        }
        try {
          let shared;
          let readFailure;
          try {
            shared = await store.read();
          } catch (error) {
            readFailure = error;
            markStorageError(error, notify && !storageErrorActive);
          }
          if (readFailure) {
            if (!(readFailure instanceof InvalidSharedQuotaCacheError)) return;
            cache = latestCache;
            await store.write(cache, lease);
            migrationPending = false;
            storageProbeRequired = false;
            clearStorageError();
          } else if (shared) {
            migrationPending = false;
            cache = adoptCache(shared);
            if (storageProbeRequired) {
              await store.write(cache, lease);
              storageProbeRequired = false;
              clearStorageError();
            }
          } else {
            cache = quotaCache(
              selectMissingCacheFallback({
                migrationPending,
                legacy: legacyCache,
                latest: latestCache
              })
            );
            await store.write(cache, lease);
            latestCache = cache;
            migrationPending = false;
            storageProbeRequired = false;
            clearStorageError();
            setState(stateFromCache(cache, { loadingWhenEmpty: true }));
          }
        } catch (error) {
          if (error instanceof LeaseLostError) {
            leaseLost = true;
            await adoptAfterLeaseLoss(notify);
          } else {
            markStorageError(error, notify);
          }
          return;
        }
        if (!baseURL || !key) {
          setState((previous) => ({ ...previous, status: configuredStatus() }));
          scheduleRefresh(SHARED_SYNC_MS);
          return;
        }
        if (!allowUpstream) {
          scheduleRefresh(SHARED_SYNC_MS);
          return;
        }
        const lockedNow = Date.now();
        const lockedTargets = refreshTargets(cache, lockedNow, notify);
        if (!lockedTargets && cache.retryAt && cache.retryAt > lockedNow) {
          scheduleFromCache(cache, lockedNow);
          if (notify) showRetryToast(cache, lockedNow);
          return;
        }
        const lockedVersion = cacheVersion(cache);
        if (!lockedTargets && !notify && lockedVersion && lockedNow - lockedVersion < refreshMs) {
          scheduleFromCache(cache, lockedNow);
          return;
        }
        if (lockedTargets?.size === 0) {
          scheduleFromCache(cache, lockedNow);
          if (notify) showRetryToast(cache, lockedNow);
          return;
        }
        if (notify && targetsAdvanced(beforeLockCache, cache, beforeTargets)) {
          scheduleFromCache(cache, lockedNow);
          api.ui.toast({
            variant: "success",
            title: "CPA quota",
            message: "Usage was refreshed by another OpenCode process"
          });
          return;
        }
        setRefreshing(true);
        didSetRefreshing = true;
        let nextCache;
        let nextState;
        let toast;
        try {
          const fetchedResult = await fetchReports(baseURL, key, timeoutMs, lockedTargets);
          const fetched = fetchedResult.reports.map((report) => ({
            ...report,
            plan: displayPlan(report.kind, report.plan, planLabels[report.kind])
          }));
          if (api.lifecycle.signal.aborted) return;
          const checkedAt = Date.now();
          const refreshedKinds = lockedTargets ?? new Set(PROVIDER_KINDS);
          const providerRefresh2 = providerRefreshState2(cache);
          for (const kind of refreshedKinds) {
            if (!fetchedResult.supportedKinds.has(kind)) {
              delete providerRefresh2[kind];
              continue;
            }
            const providerReports = fetched.filter((report) => report.kind === kind);
            const limited = providerReports.some((report) => rateLimited(report.error));
            const failures = limited ? (providerRefresh2[kind]?.failures ?? 0) + 1 : 0;
            providerRefresh2[kind] = {
              checkedAt,
              ...limited ? { retryAt: checkedAt + backoffDelay(failures) } : {},
              failures
            };
          }
          const reports = mergeRefreshedReports(fetched, cache.reports, refreshedKinds);
          const updatedAt = fetched.some((report) => !report.error) ? checkedAt : cache.updatedAt ?? checkedAt;
          nextCache = quotaCache({ reports, updatedAt, checkedAt, failures: 0, providerRefresh: providerRefresh2 });
          nextState = stateFromCache(nextCache);
          if (notify) {
            const limitedKinds = PROVIDER_KINDS.filter(
              (kind) => fetched.some((report) => report.kind === kind && rateLimited(report.error))
            );
            const refreshed = PROVIDER_KINDS.filter(
              (kind) => fetched.some((report) => report.kind === kind && !report.error)
            );
            const cached = fetched.filter((report) => rateLimited(report.error)).every((report) => Boolean(cachedReport(report, cache.reports)));
            toast = {
              variant: limitedKinds.length ? "warning" : "success",
              message: limitedKinds.length ? `${limitedKinds.map(providerTitle).join(", ")} rate limited; ${refreshed.length ? `${refreshed.map(providerTitle).join(", ")} refreshed` : cached ? "showing cached usage" : "retry scheduled"}` : "Usage refreshed"
            };
          }
        } catch (error) {
          if (api.lifecycle.signal.aborted) return;
          const message2 = error instanceof Error ? error.message : "Quota refresh failed";
          const limited = rateLimited(message2);
          const checkedAt = Date.now();
          const providerRefresh2 = providerRefreshState2(cache);
          const attemptedKinds = lockedTargets ? [...lockedTargets] : trackedProviderKinds(cache, providerRefresh2);
          for (const kind of attemptedKinds) {
            const failures2 = limited ? (providerRefresh2[kind]?.failures ?? 0) + 1 : 0;
            providerRefresh2[kind] = {
              checkedAt,
              ...limited ? { retryAt: checkedAt + backoffDelay(failures2) } : {},
              failures: failures2
            };
          }
          const failures = limited && !attemptedKinds.length ? cache.failures + 1 : 0;
          const retryAt = limited && !attemptedKinds.length ? checkedAt + backoffDelay(failures) : void 0;
          nextCache = quotaCache({
            reports: cache.reports,
            updatedAt: cache.updatedAt,
            checkedAt,
            retryAt,
            failures,
            providerRefresh: providerRefresh2,
            error: message2
          });
          nextState = stateFromCache(nextCache);
          if (notify) {
            const nextRetryAt = retryAt ?? Math.min(
              ...attemptedKinds.map((kind) => providerRefresh2[kind]?.retryAt).filter((value) => value !== void 0)
            );
            toast = {
              variant: limited ? "warning" : "error",
              message: limited && Number.isFinite(nextRetryAt) ? `Rate limited; retry after ${retryLabel(nextRetryAt)}` : message2
            };
          }
        }
        try {
          await store.write(nextCache, lease);
        } catch (error) {
          if (error instanceof LeaseLostError) {
            leaseLost = true;
            await adoptAfterLeaseLoss(notify);
          } else {
            markStorageError(error, notify);
          }
          return;
        }
        cache = nextCache;
        latestCache = nextCache;
        storageProbeRequired = false;
        clearStorageError();
        setState(nextState);
        scheduleFromCache(nextCache);
        if (toast) api.ui.toast({ ...toast, title: "CPA quota" });
      } finally {
        if (didSetRefreshing) setRefreshing(false);
        if (lease && !leaseLost) {
          try {
            const released = await lease.release();
            if (!released && !api.lifecycle.signal.aborted) {
              markStorageError(new Error("Shared quota refresh lease was lost before release"), notify);
            }
          } catch (error) {
            markStorageError(error, notify);
          }
        }
      }
    })();
    try {
      await inflight;
    } catch (error) {
      if (!api.lifecycle.signal.aborted) {
        const message2 = error instanceof Error ? error.message : "Quota refresh failed";
        setState((previous) => ({
          ...previous,
          status: previous.reports.length ? "ready" : "error",
          error: message2
        }));
        scheduleRefresh(STORAGE_RETRY_MS);
        if (notify) {
          api.ui.toast({ variant: "error", title: "CPA quota", message: message2 });
        }
      }
    } finally {
      inflight = void 0;
    }
  };
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        const snapshot = snapshotSlotState(state, refreshing);
        return /* @__PURE__ */ jsx(
          QuotaView,
          {
            api,
            state: snapshot.state,
            refreshing: snapshot.refreshing,
            refresh
          }
        );
      }
    }
  });
  const unregisterCommand = api.command?.register(() => [
    {
      title: "Refresh CPA quota",
      value: "cpa.quota.refresh",
      category: "CPA",
      slash: { name: "quota", aliases: ["quota-refresh"] },
      onSelect: () => refresh(true)
    }
  ]);
  if (unregisterCommand) api.lifecycle.onDispose(unregisterCommand);
  scheduleRefresh(initialCache.reports.length ? TIMER_SLACK_MS : 750 + Math.random() * 2500);
  api.lifecycle.onDispose(() => {
    if (scheduled) clearTimeout(scheduled);
  });
};
var plugin = {
  id: "cpa-quota-sidebar",
  tui
};
var index_default = plugin;
export {
  index_default as default
};
