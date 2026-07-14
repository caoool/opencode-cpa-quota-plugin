function number(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(result) ? result : undefined
}

/** Normalize an upstream reset value to an absolute timestamp for cache-safe transport. */
export function resetTimestamp(value: unknown, afterSeconds?: unknown, now = Date.now()) {
  const after = number(afterSeconds)
  let target: number | undefined
  if (after !== undefined) target = now + Math.max(0, after) * 1_000
  if (target === undefined && typeof value === "number") target = value > 10_000_000_000 ? value : value * 1_000
  if (target === undefined && typeof value === "string") {
    const numeric = Number(value)
    target = Number.isFinite(numeric)
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1_000
      : Date.parse(value)
  }
  return target !== undefined && Number.isFinite(target) ? target : undefined
}

/** Format at render time so the TUI process, not the cache writer, supplies the current time zone. */
export function compactDate(timestamp: number) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return undefined
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hour}:${minute}`
}

export function compactTime(timestamp: number) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
