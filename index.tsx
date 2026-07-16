/** @jsxImportSource @opentui/solid */

/** OpenCode TUI plugin for CPA subscription quota usage. */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { compactDate, compactTime, resetTimestamp } from "./quota-time"
import {
  clampRefreshMs,
  dueProviderRefreshes,
  latestRefreshAt,
  nextRefreshDelay,
  nextProviderRefreshDelay,
  selectMissingCacheFallback,
  sharedCacheDisplayStatus,
  shouldAdoptCache,
  shouldPollAutomatically,
  snapshotSlotState,
  TIMER_SLACK_MS,
} from "./refresh-schedule"
import {
  createSharedQuotaStore,
  InvalidSharedQuotaCacheError,
  LeaseLostError,
  quotaCache,
  type ProviderKind,
  type ProviderRefreshState,
  type QuotaCache,
  type QuotaReport,
  type QuotaWindow,
  type SharedQuotaLease,
} from "./shared-quota-store"

type QuotaState = {
  status: "loading" | "ready" | "missing-base-url" | "missing-key" | "error"
  reports: QuotaReport[]
  updatedAt?: number
  checkedAt?: number
  providerRefresh?: ProviderRefreshState
  error?: string
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
  pollInAutoMode?: boolean
  planLabels?: Partial<Record<ProviderKind, string>>
  backoffMs?: number
}

const DEFAULT_REFRESH_MS = 600_000
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_BACKOFF_MS = 300_000
const MAX_BACKOFF_MS = 3_600_000
const LEGACY_CACHE_KEY = "cpa-quota-sidebar.cache.v2"
const SHARED_SYNC_MS = 5_000
const STORAGE_RETRY_MS = 5_000
const LOCK_RETRY_MS = 1_000
const PROVIDER_KINDS = ["codex", "claude", "grok"] as const satisfies readonly ProviderKind[]
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

function rateLimited(value: string | undefined) {
  return Boolean(value && /(?:429|rate[ -]?limit)/i.test(value))
}

function providerRefreshState(cache: QuotaCache): ProviderRefreshState {
  const result: ProviderRefreshState = {}
  for (const kind of PROVIDER_KINDS) {
    const current = cache.providerRefresh?.[kind]
    if (current) {
      result[kind] = { ...current }
      continue
    }
    const reports = cache.reports.filter((report) => report.kind === kind)
    if (!reports.length) continue
    const limited = reports.some((report) => rateLimited(report.error))
    const checkedAt = cache.checkedAt ?? cache.updatedAt
    result[kind] = {
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(limited && cache.retryAt !== undefined ? { retryAt: cache.retryAt } : {}),
      failures: limited ? cache.failures : 0,
    }
  }
  return result
}

function trackedProviderKinds(cache: QuotaCache, refresh = providerRefreshState(cache)) {
  const kinds = new Set<ProviderKind>(cache.reports.map((report) => report.kind))
  for (const kind of PROVIDER_KINDS) {
    if (refresh[kind]) kinds.add(kind)
  }
  return PROVIDER_KINDS.filter((kind) => kinds.has(kind))
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
    return cached ? { ...cached, plan: report.plan ?? cached.plan, error: report.error } : report
  })
}

function mergeRefreshedReports(reports: QuotaReport[], previous: QuotaReport[], refreshedKinds: Set<ProviderKind>) {
  return [
    ...previous.filter((report) => !refreshedKinds.has(report.kind)),
    ...mergeReports(reports, previous),
  ]
}

function clampPercent(value: unknown): number | undefined {
  const result = number(value)
  if (result === undefined) return undefined
  return Math.min(100, Math.max(0, result))
}

function boolFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(trimmed)) return true
    if (["false", "0", "no", "n", "off"].includes(trimmed)) return false
  }
  return undefined
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
    resetAt: resetTimestamp(window.reset_at ?? window.resetAt, window.reset_after_seconds ?? window.resetAfterSeconds),
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
  return { id, label, used, resetAt: resetTimestamp(value.resets_at ?? value.reset_at ?? value.resetsAt) }
}

function claudePlan(profile: Record<string, unknown>): string | undefined {
  const account = record(profile.account)
  const organization = record(profile.organization)
  const hasMax = boolFlag(account.has_claude_max ?? account.hasClaudeMax)
  if (hasMax) return "Max"
  const hasPro = boolFlag(account.has_claude_pro ?? account.hasClaudePro)
  if (hasPro) return "Pro"
  const organizationType = string(organization.organization_type ?? organization.organizationType)?.toLowerCase()
  const subscriptionStatus = string(organization.subscription_status ?? organization.subscriptionStatus)?.toLowerCase()
  if (organizationType === "claude_team" && subscriptionStatus === "active") return "Team"
  if (hasMax === false && hasPro === false) return "Free"
  return undefined
}

function grokPlan(monthlyBody: Record<string, unknown>): string | undefined {
  const limit = number(record(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val)
  if (limit === 15_000) return "SuperGrok"
  if (limit === 150_000) return "SuperGrok Heavy"
  return undefined
}

async function fetchClaude(file: AuthFile, baseURL: string, key: string, timeoutMs: number): Promise<QuotaReport> {
  const index = authIndex(file)
  if (!index) throw new Error("missing auth index")
  const headers = {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
  }
  const [usage, profile] = await Promise.allSettled([
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      headers,
    }),
    managementCall({
      baseURL,
      key,
      authIndex: index,
      timeoutMs,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/profile",
      headers,
    }),
  ])
  if (usage.status === "rejected") throw usage.reason
  const result = usage.value
  const windows = [
    claudeWindow(result.body, "five_hour", "5h"),
    claudeWindow(result.body, "seven_day", "7d"),
    claudeWindow(result.body, "seven_day_sonnet", "Sonnet 7d"),
    claudeWindow(result.body, "seven_day_opus", "Opus 7d"),
  ].filter((item): item is QuotaWindow => Boolean(item))
  if (!windows.length) throw new Error("quota windows unavailable")
  const plan = (profile.status === "fulfilled" ? claudePlan(profile.value.body) : undefined) ?? planLabel(result.body, result.headers, file)
  return {
    kind: "claude",
    account: accountLabel(file),
    plan,
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
  const periodType = string(period.type)?.toLowerCase() ?? ""
  const products = Array.isArray(weeklyBody.productUsage ?? weeklyBody.product_usage)
    ? ((weeklyBody.productUsage ?? weeklyBody.product_usage) as unknown[])
    : []
  if (weeklyUsed !== undefined) {
    windows.push({ id: "weekly", label: "Week", used: weeklyUsed, resetAt: resetTimestamp(period.end) })
  } else if (periodType.includes("weekly") && !products.length) {
    windows.push({ id: "weekly", label: "Week", used: 0, resetAt: resetTimestamp(period.end) })
  }
  for (const raw of products.slice(0, 2)) {
    const product = record(raw)
    const used = clampPercent(product.usagePercent ?? product.usage_percent)
    if (used === undefined) continue
    const name = string(product.product) ?? "Product"
    windows.push({ id: `product-${name}`, label: name, used, resetAt: resetTimestamp(period.end) })
  }
  const limit = number(record(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val)
  const usedCredits = number(record(monthlyBody.used).val)
  if (limit && usedCredits !== undefined) {
    windows.push({
      id: "monthly",
      label: "Month",
      used: Math.min(100, Math.max(0, (usedCredits / limit) * 100)),
      resetAt: resetTimestamp(monthlyBody.billingPeriodEnd ?? monthlyBody.billing_period_end),
    })
  }
  if (!windows.length) throw new Error("quota windows unavailable")
  const plan =
    grokPlan(monthlyBody) ??
    planLabel(
      weeklyBody,
      monthlyBody,
      weekly.status === "fulfilled" ? weekly.value.headers : undefined,
      monthly.status === "fulfilled" ? monthly.value.headers : undefined,
      file,
    )
  return {
    kind: "grok",
    account: accountLabel(file),
    plan,
    windows,
  }
}

async function fetchReports(
  baseURL: string,
  key: string,
  timeoutMs: number,
  kinds?: ReadonlySet<ProviderKind>,
): Promise<{ reports: QuotaReport[]; supportedKinds: Set<ProviderKind> }> {
  const auth = await requestJSON<Record<string, unknown>>(
    `${baseURL}/v0/management/auth-files`,
    { headers: { Authorization: `Bearer ${key}` } },
    timeoutMs,
  )
  const files = Array.isArray(auth.files) ? (auth.files as AuthFile[]) : []
  const supported = files.map((file) => ({ file, kind: providerKind(file) })).filter((item) => item.kind)
  if (!supported.length) throw new Error("no supported CPA auth files")
  const selected = kinds ? supported.filter(({ kind }) => kind && kinds.has(kind)) : supported
  const reports = await Promise.all(
    selected.map(async ({ file, kind }) => {
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
  return {
    reports,
    supportedKinds: new Set(supported.map(({ kind }) => kind!)),
  }
}

function QuotaView(props: {
  api: TuiPluginApi
  state: QuotaState
  refreshing: boolean
  refresh: (notify?: boolean) => Promise<void>
}) {
  const reports = createMemo(() =>
    [...props.state.reports].sort(
      (left, right) => PROVIDER_ORDER[left.kind] - PROVIDER_ORDER[right.kind] || left.account.localeCompare(right.account),
    ),
  )
  const checked = createMemo(() => {
    const value = props.state.checkedAt ?? props.state.updatedAt
    if (!value) return undefined
    return compactTime(value)
  })
  const reportError = (report: QuotaReport) => {
    if (!report.error) return undefined
    const error = report.error.replace(/\s*·\s*retry\s+.*$/i, "")
    const retryAt = props.state.providerRefresh?.[report.kind]?.retryAt
    if (!rateLimited(error) || retryAt === undefined) return error
    const retry = compactTime(retryAt)
    return retry ? `${error} · retry ${retry}` : error
  }

  return (
    <box width="100%">
      <box width="100%" flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={props.api.theme.current.text}>
          <b>Quota</b>
        </text>
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={props.api.theme.current.textMuted}>{props.refreshing ? "refreshing" : checked()}</text>
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

      <Show when={props.state.status === "missing-key"}>
        <text fg={props.api.theme.current.warning}>Set managementKey in tui.json</text>
        <text fg={props.api.theme.current.textMuted}>then restart OpenCode</text>
      </Show>

      <Show when={props.state.status === "missing-base-url"}>
        <text fg={props.api.theme.current.warning}>Set baseURL in tui.json</text>
        <text fg={props.api.theme.current.textMuted}>then restart OpenCode</text>
      </Show>

      <Show when={props.state.status === "loading" && !props.state.reports.length}>
        <text fg={props.api.theme.current.textMuted}>Loading subscription usage…</text>
      </Show>

      <Show when={props.state.status === "error" && !props.state.reports.length}>
        <text fg={props.api.theme.current.error}>{props.state.error ?? "Quota unavailable"}</text>
      </Show>

      <Show when={props.state.error && !props.state.reports.length && props.state.status !== "error"}>
        <text fg={props.api.theme.current.error}>{props.state.error}</text>
      </Show>

      <Show when={props.state.error && props.state.reports.length}>
        <text fg={props.api.theme.current.warning}>{props.state.error}</text>
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
              <Show when={reportError(report)}>
                {(error) => <text fg={props.api.theme.current.warning}>{error()}</text>}
              </Show>
              <For each={report.windows}>
                {(window) => {
                  const color = () => quotaColor(props.api, window.used)
                  const reset = () => (window.resetAt === undefined ? undefined : compactDate(window.resetAt))
                  return (
                    <box width="100%" height={1} flexDirection="row" justifyContent="space-between">
                      <text fg={props.api.theme.current.textMuted}>{window.label}</text>
                      <box flexDirection="row">
                        <text fg={color()}>
                          <b>{percentLabel(window.used)}</b>
                        </text>
                        <Show when={reset()}>
                          {(label) => <text fg={props.api.theme.current.textMuted}> | {label()}</text>}
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

      <Show when={props.state.status === "ready" && !reports().length}>
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
  const refreshMs = clampRefreshMs(number(options.refreshMs) ?? DEFAULT_REFRESH_MS)
  const timeoutMs = Math.max(5_000, number(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS)
  const backoffMs = Math.max(60_000, number(options.backoffMs) ?? DEFAULT_BACKOFF_MS)
  const leaseMs = timeoutMs * 2 + 15_000
  const automaticPolling = shouldPollAutomatically(autoMode, options.pollInAutoMode === true)
  const key = string(options.managementKey)
  const planLabels = record(options.planLabels)
  const store = createSharedQuotaStore({ stateDir: api.state.path.state })
  const legacyValue = api.kv.get(LEGACY_CACHE_KEY, {})
  const legacyCache = quotaCache(legacyValue)
  let initialCache = quotaCache({})
  let initialStorageError: string | undefined
  let migrationPending = true
  try {
    const initial = await store.initializeFromLegacy(legacyValue, leaseMs)
    initialCache = initial.cache ?? initialCache
    migrationPending = initial.busy && !initial.cache
  } catch (error) {
    initialStorageError = error instanceof Error ? error.message : "Shared quota cache initialization failed"
    migrationPending = !(error instanceof InvalidSharedQuotaCacheError)
  }

  const configuredStatus = () => (!baseURL ? "missing-base-url" : !key ? "missing-key" : "ready") as QuotaState["status"]
  const cacheVersion = (cache: QuotaCache) => {
    const providerChecks = Object.values(cache.providerRefresh ?? {}).map((refresh) => refresh?.checkedAt)
    return latestRefreshAt([cache.updatedAt, cache.checkedAt, ...providerChecks])
  }
  const stateFromCache = (
    cache: QuotaCache,
    options: { error?: string; loadingWhenEmpty?: boolean } = {},
  ): QuotaState => {
    const error = options.error ?? cache.error
    const configured = configuredStatus()
    const loading =
      configured === "ready" &&
      options.loadingWhenEmpty === true &&
      !error &&
      cache.reports.length === 0 &&
      cacheVersion(cache) === undefined
    const status = loading
      ? "loading"
      : sharedCacheDisplayStatus({
          configuredStatus: configured,
          readyStatus: "ready" as QuotaState["status"],
          errorStatus: "error" as QuotaState["status"],
          reportCount: cache.reports.length,
          error,
        })
    return {
      status,
      reports: cache.reports,
      updatedAt: cache.updatedAt,
      checkedAt: cacheVersion(cache),
      providerRefresh: cache.providerRefresh,
      error,
    }
  }
  let latestCache = initialCache
  const [state, setState] = createSignal<QuotaState>(
    stateFromCache(initialCache, { error: initialStorageError, loadingWhenEmpty: true }),
  )
  const [refreshing, setRefreshing] = createSignal(false)
  let inflight: Promise<void> | undefined
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let refresh: (notify?: boolean) => Promise<void>
  let storageErrorActive = Boolean(initialStorageError)
  let storageProbeRequired = Boolean(initialStorageError)

  const scheduleRefresh = (delay: number) => {
    if (api.lifecycle.signal.aborted) return
    if (scheduled) clearTimeout(scheduled)
    scheduled = setTimeout(() => {
      scheduled = undefined
      void refresh(false)
    }, Math.max(TIMER_SLACK_MS, delay))
  }

  const adoptCache = (cache: QuotaCache) => {
    const current = state()
    const currentVersion = current.checkedAt ?? current.updatedAt
    const sharedVersion = cacheVersion(cache)
    let adopted: QuotaCache | undefined
    if (
      shouldAdoptCache({
        currentHasReports: current.reports.length > 0,
        currentVersion,
        cacheHasReports: cache.reports.length > 0,
        cacheVersion: sharedVersion,
      })
    ) {
      adopted = cache
    } else if (
      (sharedVersion !== undefined && sharedVersion > (currentVersion ?? Number.NEGATIVE_INFINITY)) ||
      (currentVersion === undefined && Boolean(cache.error))
    ) {
      adopted = quotaCache({
        reports: cache.reports.length ? cache.reports : current.reports,
        updatedAt: cache.updatedAt ?? current.updatedAt,
        checkedAt: cache.checkedAt ?? current.checkedAt,
        retryAt: cache.retryAt,
        failures: cache.failures,
        providerRefresh: cache.providerRefresh ?? latestCache.providerRefresh,
        error: cache.error,
      })
    }
    if (adopted) {
      latestCache = adopted
      setState(stateFromCache(adopted, { error: storageErrorActive ? current.error : adopted.error }))
    }
    return latestCache
  }

  const retryLabel = (timestamp: number) => compactTime(timestamp) ?? "later"

  const backoffDelay = (failures: number) =>
    Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** Math.min(8, Math.max(0, failures - 1)))

  const refreshTargets = (cache: QuotaCache, now: number, force: boolean) => {
    const providerRefresh = providerRefreshState(cache)
    const kinds = trackedProviderKinds(cache, providerRefresh)
    if (!kinds.length) return undefined
    return new Set(
      dueProviderRefreshes({
        kinds,
        refresh: providerRefresh,
        refreshMs,
        now,
        force,
      }),
    )
  }

  const targetsAdvanced = (
    before: QuotaCache,
    after: QuotaCache,
    targets: ReadonlySet<ProviderKind> | undefined,
  ) => {
    if (!targets) {
      return (cacheVersion(after) ?? Number.NEGATIVE_INFINITY) > (cacheVersion(before) ?? Number.NEGATIVE_INFINITY)
    }
    if (targets.size === 0) return false
    const beforeRefresh = providerRefreshState(before)
    const afterRefresh = providerRefreshState(after)
    return [...targets].every(
      (kind) =>
        (afterRefresh[kind]?.checkedAt ?? Number.NEGATIVE_INFINITY) >
        (beforeRefresh[kind]?.checkedAt ?? Number.NEGATIVE_INFINITY),
    )
  }

  const scheduleFromCache = (cache: QuotaCache, now = Date.now()) => {
    if (!automaticPolling) {
      scheduleRefresh(SHARED_SYNC_MS)
      return
    }
    const providerRefresh = providerRefreshState(cache)
    const kinds = trackedProviderKinds(cache, providerRefresh)
    if (kinds.length) {
      scheduleRefresh(
        Math.min(
          SHARED_SYNC_MS,
          nextProviderRefreshDelay({ kinds, refresh: providerRefresh, refreshMs, now }),
        ),
      )
      return
    }
    if (cache.retryAt && cache.retryAt > now) {
      scheduleRefresh(Math.min(SHARED_SYNC_MS, cache.retryAt - now + TIMER_SLACK_MS))
      return
    }
    const checkedAt = cacheVersion(cache)
    if (checkedAt && now - checkedAt < refreshMs) {
      scheduleRefresh(Math.min(SHARED_SYNC_MS, nextRefreshDelay(checkedAt, refreshMs, now)))
      return
    }
    scheduleRefresh(TIMER_SLACK_MS)
  }

  const markStorageError = (error: unknown, notify: boolean) => {
    const message = error instanceof Error ? error.message : "Shared quota storage failed"
    storageErrorActive = true
    storageProbeRequired = true
    setState((previous) => ({
      ...previous,
      status:
        previous.status === "missing-base-url" || previous.status === "missing-key"
          ? previous.status
          : previous.reports.length
            ? "ready"
            : "error",
      error: message,
    }))
    scheduleRefresh(STORAGE_RETRY_MS)
    if (notify) api.ui.toast({ variant: "error", title: "CPA quota", message })
  }

  const clearStorageError = () => {
    if (!storageErrorActive) return
    storageErrorActive = false
    setState(stateFromCache(latestCache, { loadingWhenEmpty: true }))
  }

  const showRetryToast = (cache: QuotaCache, now = Date.now()) => {
    const providerRefresh = providerRefreshState(cache)
    const retries = trackedProviderKinds(cache, providerRefresh)
      .map((kind) => ({ kind, retryAt: providerRefresh[kind]?.retryAt }))
      .filter((item): item is { kind: ProviderKind; retryAt: number } => Boolean(item.retryAt && item.retryAt > now))
    const message = retries.length
      ? retries.map(({ kind, retryAt }) => `${providerTitle(kind)} ${retryLabel(retryAt)}`).join(" · ")
      : cache.retryAt && cache.retryAt > now
        ? retryLabel(cache.retryAt)
        : "later"
    api.ui.toast({
      variant: "warning",
      title: "CPA quota",
      message: `Rate limited; retry ${message}`,
    })
  }

  const adoptAfterLeaseLoss = async (notify: boolean) => {
    try {
      const latest = await store.read()
      if (latest) {
        migrationPending = false
        adoptCache(latest)
      }
    } catch (error) {
      markStorageError(error, notify)
      return
    }
    scheduleRefresh(LOCK_RETRY_MS)
    if (notify) {
      api.ui.toast({
        variant: "warning",
        title: "CPA quota",
        message: "Another OpenCode process owns the quota refresh; waiting for its shared result",
      })
    }
  }

  refresh = async (notify = false) => {
    if (inflight) return inflight
    inflight = (async () => {
      let cache = latestCache
      let sharedMissing = false
      try {
        const shared = await store.read()
        if (shared) {
          migrationPending = false
          cache = adoptCache(shared)
        } else sharedMissing = true
      } catch (error) {
        markStorageError(error, notify)
        cache = latestCache
      }

      const allowUpstream = notify || automaticPolling
      const needsCoordination = storageProbeRequired || migrationPending || sharedMissing
      const beforeLockCache = cache
      const now = Date.now()
      const beforeTargets = refreshTargets(cache, now, notify)

      if (!needsCoordination) {
        if (!baseURL || !key) {
          setState((previous) => ({ ...previous, status: configuredStatus() }))
          scheduleRefresh(SHARED_SYNC_MS)
          return
        }
        if (!allowUpstream) {
          scheduleRefresh(SHARED_SYNC_MS)
          return
        }
        if (!beforeTargets && cache.retryAt && cache.retryAt > now) {
          scheduleFromCache(cache, now)
          if (notify) showRetryToast(cache, now)
          return
        }
        const lastCheck = cacheVersion(cache)
        if (!beforeTargets && !notify && lastCheck && now - lastCheck < refreshMs) {
          scheduleFromCache(cache, now)
          return
        }
        if (beforeTargets?.size === 0) {
          scheduleFromCache(cache, now)
          if (notify) showRetryToast(cache, now)
          return
        }
      }

      let lease: SharedQuotaLease | undefined
      let leaseLost = false
      let didSetRefreshing = false
      try {
        try {
          lease = await store.acquireLease(leaseMs)
        } catch (error) {
          markStorageError(error, notify)
          return
        }
        if (!lease) {
          scheduleRefresh(LOCK_RETRY_MS)
          if (notify) {
            api.ui.toast({
              variant: "warning",
              title: "CPA quota",
              message: "Another OpenCode process is refreshing quota usage",
            })
          }
          return
        }

        try {
          let shared: QuotaCache | undefined
          let readFailure: unknown
          try {
            shared = await store.read()
          } catch (error) {
            readFailure = error
            markStorageError(error, notify && !storageErrorActive)
          }

          if (readFailure) {
            if (!(readFailure instanceof InvalidSharedQuotaCacheError)) return
            cache = latestCache
            await store.write(cache, lease)
            migrationPending = false
            storageProbeRequired = false
            clearStorageError()
          } else if (shared) {
            migrationPending = false
            cache = adoptCache(shared)
            if (storageProbeRequired) {
              await store.write(cache, lease)
              storageProbeRequired = false
              clearStorageError()
            }
          } else {
            cache = quotaCache(
              selectMissingCacheFallback({
                migrationPending,
                legacy: legacyCache,
                latest: latestCache,
              }),
            )
            await store.write(cache, lease)
            latestCache = cache
            migrationPending = false
            storageProbeRequired = false
            clearStorageError()
            setState(stateFromCache(cache, { loadingWhenEmpty: true }))
          }
        } catch (error) {
          if (error instanceof LeaseLostError) {
            leaseLost = true
            await adoptAfterLeaseLoss(notify)
          } else {
            markStorageError(error, notify)
          }
          return
        }

        if (!baseURL || !key) {
          setState((previous) => ({ ...previous, status: configuredStatus() }))
          scheduleRefresh(SHARED_SYNC_MS)
          return
        }
        if (!allowUpstream) {
          scheduleRefresh(SHARED_SYNC_MS)
          return
        }

        const lockedNow = Date.now()
        const lockedTargets = refreshTargets(cache, lockedNow, notify)
        if (!lockedTargets && cache.retryAt && cache.retryAt > lockedNow) {
          scheduleFromCache(cache, lockedNow)
          if (notify) showRetryToast(cache, lockedNow)
          return
        }
        const lockedVersion = cacheVersion(cache)
        if (!lockedTargets && !notify && lockedVersion && lockedNow - lockedVersion < refreshMs) {
          scheduleFromCache(cache, lockedNow)
          return
        }
        if (lockedTargets?.size === 0) {
          scheduleFromCache(cache, lockedNow)
          if (notify) showRetryToast(cache, lockedNow)
          return
        }
        if (notify && targetsAdvanced(beforeLockCache, cache, beforeTargets)) {
          scheduleFromCache(cache, lockedNow)
          api.ui.toast({
            variant: "success",
            title: "CPA quota",
            message: "Usage was refreshed by another OpenCode process",
          })
          return
        }

        setRefreshing(true)
        didSetRefreshing = true
        let nextCache: QuotaCache
        let nextState: QuotaState
        let toast:
          | { variant: "warning" | "success" | "error"; message: string }
          | undefined

        try {
          const fetchedResult = await fetchReports(baseURL, key, timeoutMs, lockedTargets)
          const fetched = fetchedResult.reports.map((report) => ({
            ...report,
            plan: displayPlan(report.kind, report.plan, planLabels[report.kind]),
          }))
          if (api.lifecycle.signal.aborted) return
          const checkedAt = Date.now()
          const refreshedKinds = lockedTargets ?? new Set<ProviderKind>(PROVIDER_KINDS)
          const providerRefresh = providerRefreshState(cache)
          for (const kind of refreshedKinds) {
            if (!fetchedResult.supportedKinds.has(kind)) {
              delete providerRefresh[kind]
              continue
            }
            const providerReports = fetched.filter((report) => report.kind === kind)
            const limited = providerReports.some((report) => rateLimited(report.error))
            const failures = limited ? (providerRefresh[kind]?.failures ?? 0) + 1 : 0
            providerRefresh[kind] = {
              checkedAt,
              ...(limited ? { retryAt: checkedAt + backoffDelay(failures) } : {}),
              failures,
            }
          }
          const reports = mergeRefreshedReports(fetched, cache.reports, refreshedKinds)
          const updatedAt = fetched.some((report) => !report.error) ? checkedAt : (cache.updatedAt ?? checkedAt)
          nextCache = quotaCache({ reports, updatedAt, checkedAt, failures: 0, providerRefresh })
          nextState = stateFromCache(nextCache)
          if (notify) {
            const limitedKinds = PROVIDER_KINDS.filter((kind) =>
              fetched.some((report) => report.kind === kind && rateLimited(report.error)),
            )
            const refreshed = PROVIDER_KINDS.filter((kind) =>
              fetched.some((report) => report.kind === kind && !report.error),
            )
            const cached = fetched
              .filter((report) => rateLimited(report.error))
              .every((report) => Boolean(cachedReport(report, cache.reports)))
            toast = {
              variant: limitedKinds.length ? "warning" : "success",
              message: limitedKinds.length
                ? `${limitedKinds.map(providerTitle).join(", ")} rate limited; ${
                    refreshed.length
                      ? `${refreshed.map(providerTitle).join(", ")} refreshed`
                      : cached
                        ? "showing cached usage"
                        : "retry scheduled"
                  }`
                : "Usage refreshed",
            }
          }
        } catch (error) {
          if (api.lifecycle.signal.aborted) return
          const message = error instanceof Error ? error.message : "Quota refresh failed"
          const limited = rateLimited(message)
          const checkedAt = Date.now()
          const providerRefresh = providerRefreshState(cache)
          const attemptedKinds = lockedTargets ? [...lockedTargets] : trackedProviderKinds(cache, providerRefresh)
          for (const kind of attemptedKinds) {
            const failures = limited ? (providerRefresh[kind]?.failures ?? 0) + 1 : 0
            providerRefresh[kind] = {
              checkedAt,
              ...(limited ? { retryAt: checkedAt + backoffDelay(failures) } : {}),
              failures,
            }
          }
          const failures = limited && !attemptedKinds.length ? cache.failures + 1 : 0
          const retryAt = limited && !attemptedKinds.length ? checkedAt + backoffDelay(failures) : undefined
          nextCache = quotaCache({
            reports: cache.reports,
            updatedAt: cache.updatedAt,
            checkedAt,
            retryAt,
            failures,
            providerRefresh,
            error: message,
          })
          nextState = stateFromCache(nextCache)
          if (notify) {
            const nextRetryAt =
              retryAt ??
              Math.min(
                ...attemptedKinds
                  .map((kind) => providerRefresh[kind]?.retryAt)
                  .filter((value): value is number => value !== undefined),
              )
            toast = {
              variant: limited ? "warning" : "error",
              message:
                limited && Number.isFinite(nextRetryAt)
                  ? `Rate limited; retry after ${retryLabel(nextRetryAt)}`
                  : message,
            }
          }
        }

        try {
          await store.write(nextCache, lease)
        } catch (error) {
          if (error instanceof LeaseLostError) {
            leaseLost = true
            await adoptAfterLeaseLoss(notify)
          } else {
            markStorageError(error, notify)
          }
          return
        }
        cache = nextCache
        latestCache = nextCache
        storageProbeRequired = false
        clearStorageError()
        setState(nextState)
        scheduleFromCache(nextCache)
        if (toast) api.ui.toast({ ...toast, title: "CPA quota" })
      } finally {
        if (didSetRefreshing) setRefreshing(false)
        if (lease && !leaseLost) {
          try {
            const released = await lease.release()
            if (!released && !api.lifecycle.signal.aborted) {
              markStorageError(new Error("Shared quota refresh lease was lost before release"), notify)
            }
          } catch (error) {
            markStorageError(error, notify)
          }
        }
      }
    })()
    try {
      await inflight
    } catch (error) {
      if (!api.lifecycle.signal.aborted) {
        const message = error instanceof Error ? error.message : "Quota refresh failed"
        setState((previous) => ({
          ...previous,
          status: previous.reports.length ? "ready" : "error",
          error: message,
        }))
        scheduleRefresh(STORAGE_RETRY_MS)
        if (notify) {
          api.ui.toast({ variant: "error", title: "CPA quota", message })
        }
      }
    } finally {
      inflight = undefined
    }
  }

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        // OpenCode's slot registry tracks signals read by the slot renderer.
        // Snapshot them here so timer-driven updates invalidate this mounted slot.
        const snapshot = snapshotSlotState(state, refreshing)
        return (
          <QuotaView
            api={api}
            state={snapshot.state}
            refreshing={snapshot.refreshing}
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

  scheduleRefresh(initialCache.reports.length ? TIMER_SLACK_MS : 750 + Math.random() * 2_500)
  api.lifecycle.onDispose(() => {
    if (scheduled) clearTimeout(scheduled)
  })
}

const plugin = {
  id: "cpa-quota-sidebar",
  tui,
} satisfies TuiPluginModule

export default plugin
