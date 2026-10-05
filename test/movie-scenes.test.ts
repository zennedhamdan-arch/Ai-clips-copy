import test from "node:test";
import assert from "node:assert/strict";
import { applySceneSelection, chooseSceneRange, narrationWordTiming, targetSecForMode } from "@/lib/movie-scenes";
import type { ExplainerScript, StoryEvent } from "@/lib/types";

function events(): StoryEvent[] {
  return [
    { id: "e0", startSec: 12, endSec: 26, summary: "The protagonist makes the first promise.", characters: ["Maya", "Idris"], cause: "fear", effect: null, importance: 4 },
    { id: "e1", startSec: 95, endSec: 140, summary: "The heist begins and everything goes wrong.", characters: ["Maya", "Idris", "Voss"], cause: "the trap", effect: "betrayal", importance: 9 },
    { id: "e2", startSec: 320, endSec: 345, summary: "The final confrontation resolves the betrayal.", characters: ["Maya", "Voss"], cause: null, effect: "sacrifice", importance: 8 },
  ];
}

function script(): ExplainerScript {
  const section = (heading: ExplainerScript["sections"][number]["heading"], title: string, narration: string, start: number | null, end: number | null) => ({
    heading,
    title,
    narration,
    targetSec: 12,
    visualPrompt: "",
    sceneStartSec: start,
    sceneEndSec: end,
    sceneTitle: null,
    narrationProvider: null,
    narrationKey: null,
    narrationSec: null,
    audioStatus: "pending" as const,
    error: null,
  });
  return {
    version: 1,
    title: "The Long Con",
    logline: "A heist film about trust.",
    sections: [
      section("hook", "The turn", "The moment the heist collapses is the part you never saw coming.", null, null),
      section("setup", "The promise", "It begins with a promise two people cannot keep.", 10, 30),
      section("what_happened", "The trap", "Then the trap springs and everyone loses something.", null, null),
      section("why_it_matters", "The betrayal", "Underneath it all this is a story about betrayal.", null, null),
      section("payoff", "The sacrifice", "In the end one of them pays for everyone else.", null, null),
    ],
    updatedAt: new Date().toISOString(),
  };
}

test("chooseSceneRange keeps AI-suggested ranges inside the source", () => {
  const [start, end] = chooseSceneRange("setup", 10, 30, events(), 400);
  assert.ok(start >= 0 && end <= 400);
  assert.ok(end - start >= 8, `range ${start}-${end}s must be at least the minimum scene length`);

  // A suggestion past the end of the source is clamped, never dropped.
  const [s2, e2] = chooseSceneRange("payoff", 380, 999, events(), 400);
  assert.ok(s2 >= 0 && e2 <= 400 && e2 - s2 >= 8);

  // A nonsensical suggestion (end before start) falls back to event-based picking.
  const [s3, e3] = chooseSceneRange("what_happened", 500, 100, events(), 400);
  assert.ok(s3 >= 0 && e3 <= 400);
});

test("chooseSceneRange anchors on story events when no suggestion exists", () => {
  const [start, end] = chooseSceneRange("what_happened", null, null, events(), 400);
  // e1 (importance 9, middle of the film) should drive the range.
  assert.ok(start >= 90 && start <= 100, `expected near e1 start, got ${start}`);
  assert.ok(end <= 145, `expected near e1 end, got ${end}`);
});

test("applySceneSelection produces a forward-moving, narration-sized timeline", () => {
  const result = applySceneSelection(script(), events(), 400);
  let cursor = 0;
  for (const section of result.sections) {
    assert.ok(section.sceneStartSec !== null && section.sceneEndSec !== null);
    assert.ok((section.sceneStartSec as number) >= cursor - 0.01, `section ${section.heading} starts before the previous one`);
    assert.ok((section.sceneEndSec as number) > (section.sceneStartSec as number));
    assert.ok((section.sceneEndSec as number) - (section.sceneStartSec as number) >= 8 - 0.01);
    cursor = Math.max(cursor, section.sceneStartSec as number);
  }
  // A range that cannot carry the narration must grow to fit it.
  const wide = result.sections.find((s) => s.heading === "hook");
  assert.ok(wide && (wide.sceneEndSec as number) - (wide.sceneStartSec as number) >= (wide.narrationSec ?? 10));
});

test("narrationWordTiming spreads words evenly across the duration", () => {
  const timing = narrationWordTiming("One two three four five", 10);
  assert.equal(timing.length, 5);
  assert.ok(timing[0].start >= 0);
  assert.ok(timing[4].end <= 10 + 1);
  for (let i = 1; i < timing.length; i += 1) {
    assert.ok(timing[i].start >= timing[i - 1].start);
  }
  assert.deepEqual(narrationWordTiming("  ", 10), []);
});

test("targetSecForMode clamps into the safe 30-300 window with per-mode defaults", () => {
  assert.equal(targetSecForMode("movie_explainer", null), 90);
  assert.equal(targetSecForMode("documentary", null), 120);
  assert.equal(targetSecForMode("movie_explainer", 5), 30);
  assert.equal(targetSecForMode("documentary", 999), 300);
  assert.equal(targetSecForMode("movie_explainer", 75), 75);
});
