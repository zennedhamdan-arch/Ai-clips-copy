import test from "node:test";
import assert from "node:assert/strict";
import { estimateNarrationDurationSec } from "@/lib/audio/verify";

test("estimateNarrationDurationSec scales monotonically with text length", () => {
  const short = estimateNarrationDurationSec("Once upon a time, the whole story turned on one impossible choice.");
  const long = estimateNarrationDurationSec("Once upon a time, the whole story turned on one impossible choice. ".repeat(20));
  assert.ok(short > 1, `short estimate ${short}s should exceed 1s`);
  assert.ok(long > short * 10, `long estimate ${long}s should be much bigger than ${short}s`);
});

test("estimateNarrationDurationSec floors very short text", () => {
  const one = estimateNarrationDurationSec("Yes.");
  assert.ok(one >= 1, `one-word estimate ${one}s should be at least 1s`);
});

test("estimateNarrationDurationSec handles empty text", () => {
  assert.equal(estimateNarrationDurationSec(""), 0);
  assert.equal(estimateNarrationDurationSec("   "), 0);
});
