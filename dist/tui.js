// index.tsx
import { createMemo, createSignal, For, Show } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var DEFAULT_REFRESH_MS = 6e5;
var DEFAULT_TIMEOUT_MS = 2e4;
var MIN_REFRESH_MS = 3e5;
var DEFAULT_BACKOFF_MS = 3e5;
var MAX_BACKOFF_MS = 36e5;
var CACHE_KEY = "cpa-quota-sidebar.cache.v2";
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
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function number(value) {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : void 0;
}
function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function quotaCache(value) {
  const source = record(value);
  return {
    reports: Array.isArray(source.reports) ? source.reports : [],
    updatedAt: number(source.updatedAt),
    retryAt: number(source.retryAt),
    failures: number(source.failures) ?? 0,
    leaseOwner: string(source.leaseOwner),
    leaseUntil: number(source.leaseUntil)
  };
}
function rateLimited(value) {
  return Boolean(value && /(?:429|rate[ -]?limit)/i.test(value));
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
    return cached ? { ...cached, plan: report.plan ?? cached.plan } : report;
  });
}
function clampPercent(value) {
  const result = number(value);
  if (result === void 0) return void 0;
  return Math.min(100, Math.max(0, result));
}
function normalizeBaseURL(value) {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}
function shortAccount(value) {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.length > 18 ? `${name.slice(0, 15)}\u2026` : name;
}
function providerKind(file) {
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
  const source = record(file);
  const metadata = record(source.metadata);
  return shortAccount(
    string(source.email) ?? string(metadata.email) ?? string(source.account) ?? string(source.name) ?? providerTitle(providerKind(file) ?? "codex")
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
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return void 0;
  }
}
function findNestedString(value, keys, depth = 0) {
  if (depth > 7 || !value || typeof value !== "object") return void 0;
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) {
      const result = string(item);
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
    const direct = string(item);
    if (direct) return direct;
    const nested = record(item);
    const named = string(nested.name) ?? string(nested.label) ?? string(nested.tier) ?? string(nested.type);
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
  return string(configured);
}
function chatGPTAccountID(file) {
  const direct = findNestedString(file, /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"]));
  if (direct) return direct;
  const source = record(file);
  const metadata = record(source.metadata);
  return findNestedString(decodeJWT(source.id_token), /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"])) ?? findNestedString(decodeJWT(metadata.id_token), /* @__PURE__ */ new Set(["chatgpt_account_id", "chatgptaccountid"]));
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
function resetLabel(value, afterSeconds) {
  const after = number(afterSeconds);
  let target;
  if (after !== void 0) target = Date.now() + Math.max(0, after) * 1e3;
  if (target === void 0 && typeof value === "number") target = value > 1e10 ? value : value * 1e3;
  if (target === void 0 && typeof value === "string") {
    const numeric = Number(value);
    target = Number.isFinite(numeric) ? numeric > 1e10 ? numeric : numeric * 1e3 : Date.parse(value);
  }
  if (!target || !Number.isFinite(target)) return void 0;
  return compactDate(target);
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
  const status = number(envelope.status_code ?? envelope.statusCode) ?? 0;
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
  return { body: record(body), headers: record(envelope.header ?? envelope.headers) };
}
function authIndex(file) {
  const result = file.auth_index;
  if (typeof result === "number") return String(result);
  return string(result);
}
function codexWindow(value, fallback) {
  const window = record(value);
  const used = clampPercent(window.used_percent ?? window.usedPercent);
  if (used === void 0) return void 0;
  const seconds = number(window.limit_window_seconds ?? window.limitWindowSeconds);
  const label = seconds && seconds >= 5e5 ? "7d" : seconds && seconds >= 14e3 ? "5h" : fallback;
  return {
    id: label,
    label,
    used,
    reset: resetLabel(window.reset_at ?? window.resetAt, window.reset_after_seconds ?? window.resetAfterSeconds)
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
  const rate = record(result.body.rate_limit ?? result.body.rateLimit);
  const windows = [codexWindow(rate.primary_window ?? rate.primaryWindow, "5h"), codexWindow(rate.secondary_window ?? rate.secondaryWindow, "7d")].filter(
    (item) => Boolean(item)
  );
  if (!windows.length) throw new Error("quota windows unavailable");
  return {
    kind: "codex",
    account: accountLabel(file),
    plan: string(result.body.plan_type ?? result.body.planType) ?? planLabel(result.body, result.headers, file),
    windows
  };
}
function claudeWindow(body, id, label) {
  const value = record(body[id]);
  const used = clampPercent(value.utilization ?? value.percent);
  if (used === void 0) return void 0;
  return { id, label, used, reset: resetLabel(value.resets_at ?? value.reset_at ?? value.resetsAt) };
}
async function fetchClaude(file, baseURL, key, timeoutMs) {
  const index = authIndex(file);
  if (!index) throw new Error("missing auth index");
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
      "anthropic-beta": "oauth-2025-04-20"
    }
  });
  const windows = [
    claudeWindow(result.body, "five_hour", "5h"),
    claudeWindow(result.body, "seven_day", "7d"),
    claudeWindow(result.body, "seven_day_sonnet", "Sonnet 7d"),
    claudeWindow(result.body, "seven_day_opus", "Opus 7d")
  ].filter((item) => Boolean(item));
  if (!windows.length) throw new Error("quota windows unavailable");
  return {
    kind: "claude",
    account: accountLabel(file),
    plan: planLabel(result.body, result.headers, file),
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
  const weeklyBody = weekly.status === "fulfilled" ? record(weekly.value.body.config ?? weekly.value.body) : {};
  const monthlyBody = monthly.status === "fulfilled" ? record(monthly.value.body.config ?? monthly.value.body) : {};
  const windows = [];
  const weeklyUsed = clampPercent(weeklyBody.creditUsagePercent ?? weeklyBody.credit_usage_percent);
  const period = record(weeklyBody.currentPeriod ?? weeklyBody.current_period);
  if (weeklyUsed !== void 0) {
    windows.push({ id: "weekly", label: "Week", used: weeklyUsed, reset: resetLabel(period.end) });
  }
  const products = Array.isArray(weeklyBody.productUsage ?? weeklyBody.product_usage) ? weeklyBody.productUsage ?? weeklyBody.product_usage : [];
  for (const raw of products.slice(0, 2)) {
    const product = record(raw);
    const used = clampPercent(product.usagePercent ?? product.usage_percent);
    if (used === void 0) continue;
    const name = string(product.product) ?? "Product";
    windows.push({ id: `product-${name}`, label: name, used, reset: resetLabel(period.end) });
  }
  const limit = number(record(monthlyBody.monthlyLimit ?? monthlyBody.monthly_limit).val);
  const usedCredits = number(record(monthlyBody.used).val);
  if (limit && usedCredits !== void 0) {
    windows.push({
      id: "monthly",
      label: "Month",
      used: Math.min(100, Math.max(0, usedCredits / limit * 100)),
      reset: resetLabel(monthlyBody.billingPeriodEnd ?? monthlyBody.billing_period_end)
    });
  }
  if (!windows.length) throw new Error("quota windows unavailable");
  return {
    kind: "grok",
    account: accountLabel(file),
    plan: planLabel(
      weeklyBody,
      monthlyBody,
      weekly.status === "fulfilled" ? weekly.value.headers : void 0,
      monthly.status === "fulfilled" ? monthly.value.headers : void 0,
      file
    ),
    windows
  };
}
async function fetchReports(baseURL, key, timeoutMs) {
  const auth = await requestJSON(
    `${baseURL}/v0/management/auth-files`,
    { headers: { Authorization: `Bearer ${key}` } },
    timeoutMs
  );
  const files = Array.isArray(auth.files) ? auth.files : [];
  const supported = files.map((file) => ({ file, kind: providerKind(file) })).filter((item) => item.kind);
  if (!supported.length) throw new Error("no supported CPA auth files");
  return Promise.all(
    supported.map(async ({ file, kind }) => {
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
}
function QuotaView(props) {
  const reports = createMemo(
    () => [...props.state().reports].sort(
      (left, right) => PROVIDER_ORDER[left.kind] - PROVIDER_ORDER[right.kind] || left.account.localeCompare(right.account)
    )
  );
  const updated = createMemo(() => {
    const value = props.state().updatedAt;
    if (!value) return void 0;
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  });
  return /* @__PURE__ */ jsxs("box", { width: "100%", children: [
    /* @__PURE__ */ jsxs("box", { width: "100%", flexDirection: "row", justifyContent: "space-between", marginBottom: 1, children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.text, children: /* @__PURE__ */ jsx("b", { children: "Quota" }) }),
      /* @__PURE__ */ jsxs("box", { flexDirection: "row", alignItems: "center", gap: 1, children: [
        /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: props.refreshing() ? "refreshing" : updated() }),
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
    /* @__PURE__ */ jsxs(Show, { when: props.state().status === "missing-key", children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: "Set managementKey in tui.json" }),
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "then restart OpenCode" })
    ] }),
    /* @__PURE__ */ jsxs(Show, { when: props.state().status === "missing-base-url", children: [
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: "Set baseURL in tui.json" }),
      /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "then restart OpenCode" })
    ] }),
    /* @__PURE__ */ jsx(Show, { when: props.state().status === "loading" && !props.state().reports.length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "Loading subscription usage\u2026" }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state().status === "error" && !props.state().reports.length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.error, children: props.state().error ?? "Quota unavailable" }) }),
    /* @__PURE__ */ jsx("box", { width: "100%", gap: 1, children: /* @__PURE__ */ jsx(For, { each: reports(), children: (report) => /* @__PURE__ */ jsxs("box", { width: "100%", children: [
      /* @__PURE__ */ jsxs("box", { width: "100%", flexDirection: "row", justifyContent: "space-between", children: [
        /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.text, children: /* @__PURE__ */ jsx("b", { children: providerTitle(report.kind) }) }),
        /* @__PURE__ */ jsx(Show, { when: report.plan, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: report.plan }) })
      ] }),
      /* @__PURE__ */ jsx(Show, { when: report.error, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.warning, children: report.error }) }),
      /* @__PURE__ */ jsx(For, { each: report.windows, children: (window) => {
        const color = () => quotaColor(props.api, window.used);
        return /* @__PURE__ */ jsxs("box", { width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between", children: [
          /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: window.label }),
          /* @__PURE__ */ jsxs("box", { flexDirection: "row", children: [
            /* @__PURE__ */ jsx("text", { fg: color(), children: /* @__PURE__ */ jsx("b", { children: percentLabel(window.used) }) }),
            /* @__PURE__ */ jsx(Show, { when: window.reset, children: /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
              " | ",
              window.reset
            ] }) })
          ] })
        ] });
      } })
    ] }) }) }),
    /* @__PURE__ */ jsx(Show, { when: props.state().status === "ready" && !reports().length, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: "No supported quota accounts" }) })
  ] });
}
var tui = async (api, rawOptions) => {
  const autoMode = process.argv.includes("--auto");
  const options = rawOptions ?? {};
  const rawBaseURL = string(options.baseURL);
  const baseURL = rawBaseURL ? normalizeBaseURL(rawBaseURL) : void 0;
  const refreshMs = Math.max(MIN_REFRESH_MS, number(options.refreshMs) ?? DEFAULT_REFRESH_MS);
  const timeoutMs = Math.max(5e3, number(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS);
  const backoffMs = Math.max(6e4, number(options.backoffMs) ?? DEFAULT_BACKOFF_MS);
  const key = string(options.managementKey);
  const planLabels = record(options.planLabels);
  const instanceID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const readCache = () => quotaCache(api.kv.get(CACHE_KEY, {}));
  const writeCache = (value) => api.kv.set(CACHE_KEY, value);
  const initialCache = readCache();
  const [state, setState] = createSignal(
    !baseURL ? { status: "missing-base-url", reports: [] } : !key ? { status: "missing-key", reports: [] } : initialCache.reports.length ? { status: "ready", reports: initialCache.reports, updatedAt: initialCache.updatedAt } : { status: "loading", reports: [] }
  );
  const [refreshing, setRefreshing] = createSignal(false);
  let inflight;
  let scheduled;
  let refresh;
  const scheduleRefresh = (delay) => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => void refresh(false), Math.max(250, delay));
  };
  const retryLabel = (timestamp) => new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const backoffDelay = (failures) => Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** Math.min(8, Math.max(0, failures - 1)));
  refresh = async (notify = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!baseURL) {
        setState({ status: "missing-base-url", reports: [] });
        return;
      }
      if (!key) {
        setState({ status: "missing-key", reports: [] });
        return;
      }
      const now = Date.now();
      let cache = readCache();
      if (cache.reports.length && !state().reports.length) {
        setState({ status: "ready", reports: cache.reports, updatedAt: cache.updatedAt });
      }
      if (cache.retryAt && cache.retryAt > now) {
        scheduleRefresh(cache.retryAt - now + 250);
        if (notify) {
          api.ui.toast({
            variant: "warning",
            title: "CPA quota",
            message: `Rate limited; retry after ${retryLabel(cache.retryAt)}`
          });
        }
        return;
      }
      const retryDue = cache.retryAt !== void 0 && cache.retryAt <= now;
      if (!notify && !retryDue && cache.updatedAt && now - cache.updatedAt < refreshMs) return;
      if (cache.leaseOwner && cache.leaseOwner !== instanceID && cache.leaseUntil && cache.leaseUntil > now) {
        scheduleRefresh(Math.min(5e3, Math.max(750, cache.leaseUntil - now + 250)));
        return;
      }
      writeCache({ ...cache, leaseOwner: instanceID, leaseUntil: now + timeoutMs + 5e3 });
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));
      cache = readCache();
      if (cache.leaseOwner !== instanceID) {
        scheduleRefresh(750 + Math.random() * 1e3);
        return;
      }
      setRefreshing(true);
      try {
        const fetched = (await fetchReports(baseURL, key, timeoutMs)).map((report) => ({
          ...report,
          plan: displayPlan(report.kind, report.plan, planLabels[report.kind])
        }));
        if (api.lifecycle.signal.aborted) return;
        const limited = fetched.filter((report) => rateLimited(report.error));
        const failures = limited.length ? cache.failures + 1 : 0;
        const retryAt = limited.length ? Date.now() + backoffDelay(failures) : void 0;
        const displayFetched = fetched.map(
          (report) => rateLimited(report.error) && retryAt ? { ...report, error: `Rate limited \xB7 retry ${retryLabel(retryAt)}` } : report
        );
        const reports = mergeReports(displayFetched, cache.reports);
        const complete = fetched.every((report) => !report.error);
        const updatedAt = complete ? Date.now() : cache.updatedAt ?? Date.now();
        writeCache({ reports, updatedAt, retryAt, failures });
        setState({ status: "ready", reports, updatedAt });
        if (retryAt) scheduleRefresh(retryAt - Date.now() + 250);
        if (notify) {
          const cached = limited.every((report) => Boolean(cachedReport(report, cache.reports)));
          api.ui.toast({
            variant: limited.length ? "warning" : "success",
            title: "CPA quota",
            message: limited.length ? `${limited.map((report) => providerTitle(report.kind)).join(", ")} rate limited; ${cached ? "showing cached usage" : `retry after ${retryLabel(retryAt)}`}` : "Usage refreshed"
          });
        }
      } catch (error) {
        if (api.lifecycle.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Quota refresh failed";
        const limited = rateLimited(message);
        const failures = limited ? cache.failures + 1 : cache.failures;
        const retryAt = limited ? Date.now() + backoffDelay(failures) : void 0;
        writeCache({
          reports: cache.reports,
          updatedAt: cache.updatedAt,
          retryAt,
          failures
        });
        if (retryAt) scheduleRefresh(retryAt - Date.now() + 250);
        setState((previous) => ({
          status: previous.reports.length ? "ready" : "error",
          reports: previous.reports,
          updatedAt: previous.updatedAt,
          error: message
        }));
        if (notify) {
          api.ui.toast({
            variant: limited ? "warning" : "error",
            title: "CPA quota",
            message: limited && retryAt ? `Rate limited; retry after ${retryLabel(retryAt)}` : message
          });
        }
      } finally {
        const latest = readCache();
        if (latest.leaseOwner === instanceID) {
          writeCache({ ...latest, leaseOwner: void 0, leaseUntil: void 0 });
        }
        setRefreshing(false);
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = void 0;
    }
  };
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return /* @__PURE__ */ jsx(
          QuotaView,
          {
            api,
            state,
            refreshing,
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
  const timer = autoMode ? void 0 : setInterval(() => void refresh(false), refreshMs);
  const initialTimer = autoMode ? void 0 : setTimeout(
    () => void refresh(false),
    initialCache.reports.length ? 250 : 750 + Math.random() * 2500
  );
  api.lifecycle.onDispose(() => {
    if (timer) clearInterval(timer);
    if (initialTimer) clearTimeout(initialTimer);
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
