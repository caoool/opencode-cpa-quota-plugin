/** @jsxImportSource @opentui/solid */

/** OpenCode TUI plugin for CPA subscription quota usage. */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"

type ProviderKind = "codex" | "claude" | "grok"

type QuotaWindow = {
  id: string
  label: string
  used: number
  reset?: string
}

type QuotaReport = {
  kind: ProviderKind
  account: string
  plan?: string
  windows: QuotaWindow[]
  error?: string
}

type QuotaState = {
  status: "loading" | "ready" | "missing-base-url" | "missing-key" | "error"
  reports: QuotaReport[]
  updatedAt?: number
  error?: string
}

type QuotaCache = {
  reports: QuotaReport[]
  updatedAt?: number
  retryAt?: number
  failures: number
  leaseOwner?: string
  leaseUntil?: number
}

type AuthFile = Record<string, unknown> & {
  auth_index?: string | number
  provider?: string
  type?: string
  name?: string
}

type PluginOptions = {
  baseURL?: string
  refreshMs?: number
  timeoutMs?: number
  managementKey?: string
  planLabels?: Partial<Record<ProviderKind, string>>
  backoffMs?: number
}

const DEFAULT_REFRESH_MS = 600_000
const DEFAULT_TIMEOUT_MS = 20_000
const MIN_REFRESH_MS = 300_000
const DEFAULT_BACKOFF_MS = 300_000
const MAX_BACKOFF_MS = 3_600_000
const CACHE_KEY = "cpa-quota-sidebar.cache.v2"
const PROVIDER_ORDER: Record<ProviderKind, number> = { codex: 0, claude: 1, grok: 2 }
const PLAN_KEYS = new Set([
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
  "tiername",
])

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

function quotaCache(value: unknown): QuotaCache {
  const source = record(value)
  return {
    reports: Array.isArray(source.reports) ? (source.reports as QuotaReport[]) : [],
    updatedAt: number(source.updatedAt),
    retryAt: number(source.retryAt),
    failures: number(source.failures) ?? 0,
    leaseOwner: string(source.leaseOwner),
    leaseUntil: number(source.leaseUntil),
  }
}

function rateLimited(value: string | undefined) {
  return Boolean(value && /(?:429|rate[ -]?limit)/i.test(value))
}

function cachedReport(report: QuotaReport, previous: QuotaReport[]) {
  const exact = previous.find((item) => item.kind === report.kind && item.account === report.account)
  if (exact?.windows.length) return exact
  const sameKind = previous.filter((item) => item.kind === report.kind && item.windows.length)
  return sameKind.length === 1 ? sameKind[0] : undefined
}

function mergeReports(reports: QuotaReport[], previous: QuotaReport[]) {
  return reports.map((report) => {
    if (!report.error) return report
    const cached = cachedReport(report, previous)
    return cached ? { ...cached, plan: report.plan ?? cached.plan } : report
  })
}

function clampPercent(value: unknown): number | undefined {
  const result = number(value)
  if (result === undefined) return undefined
  return Math.min(100, Math.max(0, result))
}

function normalizeBaseURL(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
}

function shortAccount(value: string) {
  const name = value.split(/[\\/]/).at(-1) ?? value
  return name.length > 18 ? `${name.slice(0, 15)}…` : name
}

function providerKind(file: AuthFile): ProviderKind | undefined {
  const value = [file.provider, file.type, file.name].filter(Boolean).join(" ").toLowerCase()
  if (value.includes("codex") || value.includes("openai")) return "codex"
  if (value.includes("claude") || value.includes("anthropic")) return "claude"
  if (value.includes("grok") || value.includes("xai")) return "grok"
  return undefined
}

function providerTitle(kind: ProviderKind) {
  if (kind === "codex") return "Codex"
  if (kind === "claude") return "Claude"
  return "Grok"
}

function accountLabel(file: AuthFile) {
  const source = record(file)
  const metadata = record(source.metadata)
  return shortAccount(
    string(source.email) ??
      string(metadata.email) ??
      string(source.account) ??
      string(source.name) ??
      providerTitle(providerKind(file) ?? "codex"),
  )
}

function decodeJWT(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>
  if (typeof value !== "string") return undefined
  const part = value.split(".")[1]
  if (!part) return undefined
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    return record(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return undefined
  }
}

function findNestedString(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 7 || !value || typeof value !== "object") return undefined
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase())) {
      const result = string(item)
      if (result) return result
    }
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const result = findNestedString(item, keys, depth + 1)
    if (result) return result
  }
  return undefined
}

function findPlan(value: unknown, depth = 0): string | undefined {
  if (depth > 7 || !value || typeof value !== "object") return undefined
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!PLAN_KEYS.has(key.toLowerCase())) continue
    const direct = string(item)
    if (direct) return direct
    const nested = record(item)
    const named = string(nested.name) ?? string(nested.label) ?? string(nested.tier) ?? string(nested.type)
    if (named) return named
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const result = findPlan(item, depth + 1)
    if (result) return result
  }
  return undefined
}

function planLabel(...values: unknown[]) {
  for (const value of values) {
    const result = findPlan(value)
    if (result) return result
  }
  return undefined
}

function displayPlan(kind: ProviderKind, fetched: string | undefined, configured: unknown) {
  if (fetched) {
    if (kind === "codex" && fetched.toLowerCase() === "pro") return "Pro 20x"
    return fetched
  }
  return string(configured)
}

function chatGPTAccountID(file: AuthFile) {
  const direct = findNestedString(file, new Set(["chatgpt_account_id", "chatgptaccountid"]))
  if (direct) return direct
  const source = record(file)
  const metadata = record(source.metadata)
  return (
    findNestedString(decodeJWT(source.id_token), new Set(["chatgpt_account_id", "chatgptaccountid"])) ??
    findNestedString(decodeJWT(metadata.id_token), new Set(["chatgpt_account_id", "chatgptaccountid"]))
  )
}

function compactDate(timestamp: number) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return undefined
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hour}:${minute}`
}

function resetLabel(value: unknown, afterSeconds?: unknown) {
  const after = number(afterSeconds)
  let target: number | undefined
  if (after !== undefined) target = Date.now() + Math.max(0, after) * 1_000
  if (target === undefined && typeof value === "number") target = value > 10_000_000_000 ? value : value * 1_000
  if (target === undefined && typeof value === "string") {
    const numeric = Number(value)
    target = Number.isFinite(numeric)
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1_000
      : Date.parse(value)
  }
  if (!target || !Number.isFinite(target)) return undefined
  return compactDate(target)
}

function quotaColor(api: TuiPluginApi, used: number) {
  if (used > 80) return api.theme.current.error
  if (used > 50) return api.theme.current.warning
  return api.theme.current.success
}

function percentLabel(value: number) {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`
}

async function requestJSON<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

async function managementCall(input: {
  baseURL: string
  key: string
  authIndex: string
  timeoutMs: number
  method: string
  url: string
  headers: Record<string, string>
  data?: string
}) {
  const envelope = await requestJSON<Record<string, unknown>>(
    `${input.baseURL}/v0/management/api-call`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_index: input.authIndex,
        method: input.method,
        url: input.url,
        header: input.headers,
        ...(input.data === undefined ? {} : { data: input.data }),
      }),
    },
    input.timeoutMs,
  )
  const status = number(envelope.status_code ?? envelope.statusCode) ?? 0
  if (status < 200 || status >= 300) throw new Error(`upstream HTTP ${status || "error"}`)
  const raw = envelope.body
  let body: unknown = raw
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw)
    } catch {
      throw new Error("upstream returned invalid JSON")
    }
  }
  return { body: record(body), headers: record(envelope.header ?? envelope.headers) }
}

function authIndex(file: AuthFile) {
  const result = file.auth_index
  if (typeof result === "number") return String(result)
  return string(result)
}

function codexWindow(value: unknown, fallback: string): QuotaWindow | undefined {
  const window = record(value)
  const used = clampPercent(window.used_percent ?? window.usedPercent)
  if (used === undefined) return undefined
  const seconds = number(window.limit_window_seconds ?? window.limitWindowSeconds)
  const label = seconds && seconds >= 500_000 ? "7d" : seconds && seconds >= 14_000 ? "5h" : fallback
  return {
    id: label,
    label,
    used,
    reset: resetLabel(window.reset_at ?? window.resetAt, window.reset_after_seconds ?? window.resetAfterSeconds),
  }
}

async function fetchCodex(file: AuthFile, baseURL: string, key: string, timeoutMs: number): Promise<QuotaReport> {
  const index = authIndex(file)
  if (!index) throw new Error("missing auth index")
  const headers: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    "User-Agent": "codex_cli_rs/0.76.0 (cpa-quota-sidebar)",
    Accept: "application/json",
  }
  const accountID = chatGPTAccountID(file)
  if (accountID) headers["Chatgpt-Account-Id"] = accountID
  const result = await managementCall({
    baseURL,
    key,
    authIndex: index,
    timeoutMs,
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers,
  })
  const rate = record(result.body.rate_limit ?? result.body.rateLimit)
  const windows = [codexWindow(rate.primary_window ?? rate.primaryWindow, "5h"), codexWindow(rate.secondary_window ?? rate.secondaryWindow, "7d")].filter(
    (item): item is QuotaWindow => Boolean(item),
  )
  if (!windows.length) throw new Error("quota windows unavailable")
  return {
    kind: "codex",
    account: accountLabel(file),
    plan: string(result.body.plan_type ?? result.body.planType) ?? planLabel(result.body, result.headers, file),
    windows,
  }
}

function claudeWindow(body: Record<string, unknown>, id: string, label: string): QuotaWindow | undefined {
  const value = record(body[id])
  const used = clampPercent(value.utilization ?? value.percent)
  if (used === undefined) return undefined
  return { id, label, used, reset: resetLabel(value.resets_at ?? value.reset_at ?? value.resetsAt) }
}

async function fetchClaude(file: AuthFile, baseURL: string, key: string, timeoutMs: number): Promise<QuotaReport> {
  const index = authIndex(file)
  if (!index) throw new Error("missing auth index")
  const result = await managementCall({
    baseURL,
    key,
    authIndex: index,
    timeoutMs,
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  })
  const windows = [
    claudeWindow(result.body, "five_hour", "5h"),
    claudeWindow(result.body, "seven_day", "7d"),
    claudeWindow(result.body, "seven_day_sonnet", "Sonnet 7d"),
    claudeWindow(result.body, "seven_day_opus", "Opus 7d"),
  ].filter((item): item is QuotaWindow => Boolean(item))
  if (!windows.length) throw new Error("quota windows unavailable")
  return {
    kind: "claude",
    account: accountLabel(file),
    plan: planLabel(result.body, result.headers, file),
    windows,
  }
}

async function fetchGrok(file: AuthFile, baseURL: string, key: string, timeoutMs: number): Promise<QuotaReport> {
  const index = authIndex(file)
  if (!index) throw new Error("missing auth index")
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.91",
    Accept: "*/*",
    "User-Agent": "grok-pager/0.2.91 grok-shell/0.2.91 (cpa-quota-sidebar)",
  }
  const [weekly, monthly] = await Promise.allSettled([
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      headers,
    }),
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://cli-chat-proxy.grok.com/v1/billing",
      headers,
    }),
  ])
  if (weekly.status === "rejected" && monthly.status === "rejected") throw new Error("billing endpoint unavailable")
  const weeklyBody = weekly.status === "fulfilled" ? record(weekly.value.body.config ?? weekly.value.body) : {}
  const monthlyBody = monthly.status === "fulfilled" ? record(monthly.value.body.config ?? monthly.value.body) : {}
  const windows: QuotaWindow[] = []
  const weeklyUsed = clampPercent(weeklyBody.creditUsagePercent ?? weeklyBody.credit_usage_percent)
  const period = record(weeklyBody.currentPeriod ?? weeklyBody.current_period)
  if (weeklyUsed !== undefined) {
    windows.push({ id: "weekly", label: "Week", used: weeklyUsed, reset: resetLabel(period.end) })
  }
  const products = Array.isArray(weeklyBody.productUsage ?? weeklyBody.product_usage)
    ? ((weeklyBody.productUsage ?? weeklyBody.product_usage) as unknown[])
    : []
  for (const raw of products.slice(0, 2)) {
    const product = record(raw)
    const used = clampPercent(product.usagePercent ?? product.usage_percent)
    if (used === undefined) continue
    const name = string(product.product) ?? "Product"
    windows.push({ id: `product-${name}`, label: name, used, reset: resetLabel(period.end) })
  }
  const limit = number(record(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val)
  const usedCredits = number(record(monthlyBody.used).val)
  if (limit && usedCredits !== undefined) {
    windows.push({
      id: "monthly",
      label: "Month",
      used: Math.min(100, Math.max(0, (usedCredits / limit) * 100)),
      reset: resetLabel(monthlyBody.billingPeriodEnd ?? monthlyBody.billing_period_end),
    })
  }
  if (!windows.length) throw new Error("quota windows unavailable")
  return {
    kind: "grok",
    account: accountLabel(file),
    plan: planLabel(
      weeklyBody,
      monthlyBody,
      weekly.status === "fulfilled" ? weekly.value.headers : undefined,
      monthly.status === "fulfilled" ? monthly.value.headers : undefined,
      file,
    ),
    windows,
  }
}

async function fetchReports(baseURL: string, key: string, timeoutMs: number): Promise<QuotaReport[]> {
  const auth = await requestJSON<Record<string, unknown>>(
    `${baseURL}/v0/management/auth-files`,
    { headers: { Authorization: `Bearer ${key}` } },
    timeoutMs,
  )
  const files = Array.isArray(auth.files) ? (auth.files as AuthFile[]) : []
  const supported = files.map((file) => ({ file, kind: providerKind(file) })).filter((item) => item.kind)
  if (!supported.length) throw new Error("no supported CPA auth files")
  return Promise.all(
    supported.map(async ({ file, kind }) => {
      try {
        if (kind === "codex") return await fetchCodex(file, baseURL, key, timeoutMs)
        if (kind === "claude") return await fetchClaude(file, baseURL, key, timeoutMs)
        return await fetchGrok(file, baseURL, key, timeoutMs)
      } catch (error) {
        return {
          kind: kind!,
          account: accountLabel(file),
          windows: [],
          error: error instanceof Error ? error.message : "quota request failed",
        }
      }
    }),
  )
}

function QuotaView(props: {
  api: TuiPluginApi
  state: () => QuotaState
  refreshing: () => boolean
  refresh: (notify?: boolean) => Promise<void>
}) {
  const reports = createMemo(() =>
    [...props.state().reports].sort(
      (left, right) => PROVIDER_ORDER[left.kind] - PROVIDER_ORDER[right.kind] || left.account.localeCompare(right.account),
    ),
  )
  const updated = createMemo(() => {
    const value = props.state().updatedAt
    if (!value) return undefined
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  })

  return (
    <box width="100%">
      <box width="100%" flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={props.api.theme.current.text}>
          <b>Quota</b>
        </text>
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={props.api.theme.current.textMuted}>{props.refreshing() ? "refreshing" : updated()}</text>
          <box
            height={1}
            paddingX={1}
            backgroundColor={props.api.theme.current.backgroundElement}
            onMouseDown={() => void props.refresh(true)}
          >
            <text fg={props.api.theme.current.primary}>↻</text>
          </box>
        </box>
      </box>

      <Show when={props.state().status === "missing-key"}>
        <text fg={props.api.theme.current.warning}>Set managementKey in tui.json</text>
        <text fg={props.api.theme.current.textMuted}>then restart OpenCode</text>
      </Show>

      <Show when={props.state().status === "missing-base-url"}>
        <text fg={props.api.theme.current.warning}>Set baseURL in tui.json</text>
        <text fg={props.api.theme.current.textMuted}>then restart OpenCode</text>
      </Show>

      <Show when={props.state().status === "loading" && !props.state().reports.length}>
        <text fg={props.api.theme.current.textMuted}>Loading subscription usage…</text>
      </Show>

      <Show when={props.state().status === "error" && !props.state().reports.length}>
        <text fg={props.api.theme.current.error}>{props.state().error ?? "Quota unavailable"}</text>
      </Show>

      <box width="100%" gap={1}>
        <For each={reports()}>
          {(report) => (
            <box width="100%">
              <box width="100%" flexDirection="row" justifyContent="space-between">
                <text fg={props.api.theme.current.text}>
                  <b>{providerTitle(report.kind)}</b>
                </text>
                <Show when={report.plan}>
                  <text fg={props.api.theme.current.textMuted}>{report.plan}</text>
                </Show>
              </box>
              <Show when={report.error}>
                <text fg={props.api.theme.current.warning}>{report.error}</text>
              </Show>
              <For each={report.windows}>
                {(window) => {
                  const color = () => quotaColor(props.api, window.used)
                  return (
                    <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
                      <text fg={props.api.theme.current.textMuted}>{window.label}</text>
                      <box flexDirection="row">
                        <text fg={color()}>
                          <b>{percentLabel(window.used)}</b>
                        </text>
                        <Show when={window.reset}>
                          <text fg={props.api.theme.current.textMuted}> | {window.reset}</text>
                        </Show>
                      </box>
                    </box>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </box>

      <Show when={props.state().status === "ready" && !reports().length}>
        <text fg={props.api.theme.current.textMuted}>No supported quota accounts</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const autoMode = process.argv.includes("--auto")
  const options = (rawOptions ?? {}) as PluginOptions
  const rawBaseURL = string(options.baseURL)
  const baseURL = rawBaseURL ? normalizeBaseURL(rawBaseURL) : undefined
  const refreshMs = Math.max(MIN_REFRESH_MS, number(options.refreshMs) ?? DEFAULT_REFRESH_MS)
  const timeoutMs = Math.max(5_000, number(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS)
  const backoffMs = Math.max(60_000, number(options.backoffMs) ?? DEFAULT_BACKOFF_MS)
  const key = string(options.managementKey)
  const planLabels = record(options.planLabels)
  const instanceID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const readCache = () => quotaCache(api.kv.get(CACHE_KEY, {}))
  const writeCache = (value: QuotaCache) => api.kv.set(CACHE_KEY, value)
  const initialCache = readCache()
  const [state, setState] = createSignal<QuotaState>(
    !baseURL
      ? { status: "missing-base-url", reports: [] }
      : !key
      ? { status: "missing-key", reports: [] }
      : initialCache.reports.length
        ? { status: "ready", reports: initialCache.reports, updatedAt: initialCache.updatedAt }
        : { status: "loading", reports: [] },
  )
  const [refreshing, setRefreshing] = createSignal(false)
  let inflight: Promise<void> | undefined
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let refresh: (notify?: boolean) => Promise<void>

  const scheduleRefresh = (delay: number) => {
    if (scheduled) clearTimeout(scheduled)
    scheduled = setTimeout(() => void refresh(false), Math.max(250, delay))
  }

  const retryLabel = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

  const backoffDelay = (failures: number) =>
    Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** Math.min(8, Math.max(0, failures - 1)))

  refresh = async (notify = false) => {
    if (inflight) return inflight
    inflight = (async () => {
      if (!baseURL) {
        setState({ status: "missing-base-url", reports: [] })
        return
      }
      if (!key) {
        setState({ status: "missing-key", reports: [] })
        return
      }

      const now = Date.now()
      let cache = readCache()
      if (cache.reports.length && !state().reports.length) {
        setState({ status: "ready", reports: cache.reports, updatedAt: cache.updatedAt })
      }

      if (cache.retryAt && cache.retryAt > now) {
        scheduleRefresh(cache.retryAt - now + 250)
        if (notify) {
          api.ui.toast({
            variant: "warning",
            title: "CPA quota",
            message: `Rate limited; retry after ${retryLabel(cache.retryAt)}`,
          })
        }
        return
      }

      const retryDue = cache.retryAt !== undefined && cache.retryAt <= now
      if (!notify && !retryDue && cache.updatedAt && now - cache.updatedAt < refreshMs) return

      if (cache.leaseOwner && cache.leaseOwner !== instanceID && cache.leaseUntil && cache.leaseUntil > now) {
        scheduleRefresh(Math.min(5_000, Math.max(750, cache.leaseUntil - now + 250)))
        return
      }

      writeCache({ ...cache, leaseOwner: instanceID, leaseUntil: now + timeoutMs + 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250))
      cache = readCache()
      if (cache.leaseOwner !== instanceID) {
        scheduleRefresh(750 + Math.random() * 1_000)
        return
      }

      setRefreshing(true)
      try {
        const fetched = (await fetchReports(baseURL, key, timeoutMs)).map((report) => ({
          ...report,
          plan: displayPlan(report.kind, report.plan, planLabels[report.kind]),
        }))
        if (api.lifecycle.signal.aborted) return
        const limited = fetched.filter((report) => rateLimited(report.error))
        const failures = limited.length ? cache.failures + 1 : 0
        const retryAt = limited.length ? Date.now() + backoffDelay(failures) : undefined
        const displayFetched = fetched.map((report) =>
          rateLimited(report.error) && retryAt
            ? { ...report, error: `Rate limited · retry ${retryLabel(retryAt)}` }
            : report,
        )
        const reports = mergeReports(displayFetched, cache.reports)
        const complete = fetched.every((report) => !report.error)
        const updatedAt = complete ? Date.now() : (cache.updatedAt ?? Date.now())
        writeCache({ reports, updatedAt, retryAt, failures })
        setState({ status: "ready", reports, updatedAt })
        if (retryAt) scheduleRefresh(retryAt - Date.now() + 250)
        if (notify) {
          const cached = limited.every((report) => Boolean(cachedReport(report, cache.reports)))
          api.ui.toast({
            variant: limited.length ? "warning" : "success",
            title: "CPA quota",
            message: limited.length
              ? `${limited.map((report) => providerTitle(report.kind)).join(", ")} rate limited; ${cached ? "showing cached usage" : `retry after ${retryLabel(retryAt!)}`}`
              : "Usage refreshed",
          })
        }
      } catch (error) {
        if (api.lifecycle.signal.aborted) return
        const message = error instanceof Error ? error.message : "Quota refresh failed"
        const limited = rateLimited(message)
        const failures = limited ? cache.failures + 1 : cache.failures
        const retryAt = limited ? Date.now() + backoffDelay(failures) : undefined
        writeCache({
          reports: cache.reports,
          updatedAt: cache.updatedAt,
          retryAt,
          failures,
        })
        if (retryAt) scheduleRefresh(retryAt - Date.now() + 250)
        setState((previous) => ({
          status: previous.reports.length ? "ready" : "error",
          reports: previous.reports,
          updatedAt: previous.updatedAt,
          error: message,
        }))
        if (notify) {
          api.ui.toast({
            variant: limited ? "warning" : "error",
            title: "CPA quota",
            message: limited && retryAt ? `Rate limited; retry after ${retryLabel(retryAt)}` : message,
          })
        }
      } finally {
        const latest = readCache()
        if (latest.leaseOwner === instanceID) {
          writeCache({ ...latest, leaseOwner: undefined, leaseUntil: undefined })
        }
        setRefreshing(false)
      }
    })()
    try {
      await inflight
    } finally {
      inflight = undefined
    }
  }

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <QuotaView
            api={api}
            state={state}
            refreshing={refreshing}
            refresh={refresh}
          />
        )
      },
    },
  })

  const unregisterCommand = api.command?.register(() => [
    {
      title: "Refresh CPA quota",
      value: "cpa.quota.refresh",
      category: "CPA",
      slash: { name: "quota", aliases: ["quota-refresh"] },
      onSelect: () => refresh(true),
    },
  ])
  if (unregisterCommand) api.lifecycle.onDispose(unregisterCommand)

  const timer = autoMode ? undefined : setInterval(() => void refresh(false), refreshMs)
  const initialTimer = autoMode
    ? undefined
    : setTimeout(
        () => void refresh(false),
        initialCache.reports.length ? 250 : 750 + Math.random() * 2_500,
      )
  api.lifecycle.onDispose(() => {
    if (timer) clearInterval(timer)
    if (initialTimer) clearTimeout(initialTimer)
    if (scheduled) clearTimeout(scheduled)
  })
}

const plugin = {
  id: "cpa-quota-sidebar",
  tui,
} satisfies TuiPluginModule

export default plugin
