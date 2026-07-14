import assert from "node:assert/strict"
import test from "node:test"
import { compactDate, compactTime, resetTimestamp } from "../quota-time"

test("normalizes reset values without formatting them in the cache writer's time zone", () => {
  const now = 1_800_000_000_000
  assert.equal(resetTimestamp(undefined, 300, now), now + 300_000)
  assert.equal(resetTimestamp(1_800_000_300), 1_800_000_300_000)
  assert.equal(resetTimestamp("1800000300000"), 1_800_000_300_000)
  assert.equal(resetTimestamp("not-a-date"), undefined)
})

test("formats the same reset timestamp in the current TUI process time zone", () => {
  const previous = process.env.TZ
  const timestamp = Date.UTC(2026, 6, 14, 12, 30)
  try {
    process.env.TZ = "UTC"
    assert.equal(compactDate(timestamp), "07/14 12:30")
    assert.match(compactTime(timestamp) ?? "", /12:30/)
    process.env.TZ = "America/Los_Angeles"
    assert.equal(compactDate(timestamp), "07/14 05:30")
    assert.match(compactTime(timestamp) ?? "", /05:30/)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
