import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTopic,
  buildScenePlan,
  documentarySignature,
  heuristicOutline,
  heuristicResearch,
  heuristicScript,
  paletteForScene,
  researchCheckpointMatches,
} from "@/lib/documentary-ai";
import { AppError } from "@/lib/errors";
import type { StoryAnalysisCheckpoint } from "@/lib/types";

const MATERIAL = [
  "The city of Salt Harbor was founded in 1884 by a group of lighthouse keepers.",
  "By 1930 the harbor employed more than ten thousand workers in shipping and salt processing.",
  "A storm in 1952 destroyed the western breakwater and shifted the city's economy overnight.",
  "Today the old warehouses have been converted into studios and the port is a heritage site.",
  "Local archives still hold the original keepers' logs, many written by hand.",
  "Historians credit the harbor with introducing modern maritime law to the region.",
].join(" ");

test("heuristicResearch uses the supplied material when it is usable", () => {
  const research = heuristicResearch("Salt Harbor's hidden history", MATERIAL);
  assert.ok(research.summary.length >= 20);
  assert.equal(research.keyPoints.length, 6);
  assert.equal(research.themes[0], "Salt Harbor's hidden history");
});

test("heuristicResearch falls back to a scaffold when material is missing", () => {
  const research = heuristicResearch("The physics of black holes", null);
  assert.ok(research.summary.toLowerCase().includes("black holes"));
  assert.ok(research.keyPoints.length >= 3, "scaffold must give the outline at least three sections");
  assert.ok(research.keyPoints.every((point) => point.point.length >= 10 && point.detail.length >= 10));
});

test("heuristicOutline + heuristicScript produce a coherent chaptered script", () => {
  const research = heuristicResearch("Salt Harbor's hidden history", MATERIAL);
  const outline = heuristicOutline(research, 120);
  assert.ok(outline.sections.length >= 3);
  assert.ok(outline.sections.length <= 8);
  assert.ok(outline.sections.every((section) => section.targetSec >= 6 && section.targetSec <= 45));

  const script = heuristicScript("Salt Harbor's hidden history", research, outline);
  assert.equal(script.sections.length, outline.sections.length);
  assert.ok(script.sections.every((section) => section.heading === "chapter"));
  assert.ok(script.sections.every((section) => section.narration.length >= 20));
  assert.ok(script.title.length >= 10);
  assert.ok(script.logline.length >= 10);
});

test("buildScenePlan tracks every field the pipeline needs", () => {
  const research = heuristicResearch("Test topic", MATERIAL);
  const script = heuristicScript("Test topic", research, heuristicOutline(research, 120));
  const scenes = buildScenePlan(script);
  assert.equal(scenes.length, script.sections.length);
  scenes.forEach((scene, index) => {
    assert.equal(scene.index, index);
    assert.ok(scene.narration.length > 0, "scene narration");
    assert.ok(scene.targetSec >= 6 && scene.targetSec <= 45, "scene duration bounds");
    assert.ok(scene.visualPrompt.length > 0, "scene visual prompt");
    assert.equal(scene.requiredAssets.length, 1, "scene required assets");
    assert.equal(scene.captions.length, scene.narration.length, "captions mirror the narration");
    assert.equal(scene.assetKey, null);
    assert.equal(scene.assetStatus, "pending");
    assert.equal(scene.audio.status, "pending");
  });
});

test("paletteForScene is stable per scene and varies across prompts", () => {
  const a = paletteForScene({ index: 0, visualPrompt: "A storm over the harbor" });
  const again = paletteForScene({ index: 0, visualPrompt: "A storm over the harbor" });
  assert.deepEqual(a, again, "same scene → same palette");
  assert.ok(
    a[0].startsWith("0x") && a[1].startsWith("0x"),
    `palette entries must be ffmpeg hex colors, got ${a}`,
  );
  const prompts = ["A storm over the harbor", "A desert at night", "A crowded market", "Deep ocean light", "A mountain at dawn"];
  const distinct = new Set(prompts.map((prompt) => JSON.stringify(paletteForScene({ index: 0, visualPrompt: prompt }))));
  assert.ok(distinct.size >= 2, "across varied prompts the palette should vary");
});

test("documentarySignature is stable and sensitive to inputs", () => {
  const one = documentarySignature("Topic A", "Material one");
  const same = documentarySignature("Topic A", "Material one");
  const other = documentarySignature("Topic A", "Material two");
  const shorter = documentarySignature("Topic", "Material one");
  assert.equal(one, same);
  assert.notEqual(one, other);
  assert.notEqual(one, shorter);
  assert.match(one, /^doc-research-v1:/);
});

test("researchCheckpointMatches only accepts matching documentary checkpoints", () => {
  const topic = "Topic A";
  const material = "Material one";
  const signature = documentarySignature(topic, material);
  const base: StoryAnalysisCheckpoint = {
    version: 1,
    variant: "documentary",
    signature,
    chunks: [],
    characters: [],
    events: [],
    arc: "",
    complete: true,
    research: { summary: "s", keyPoints: [], notableNames: [], themes: [] },
    updatedAt: new Date().toISOString(),
  };
  const materialHash = signature.split(":")[2];
  assert.equal(researchCheckpointMatches(base, topic, materialHash), true);
  assert.equal(researchCheckpointMatches(null, topic, materialHash), false);
  assert.equal(researchCheckpointMatches({ ...base, variant: "movie" }, topic, materialHash), false);
  assert.equal(researchCheckpointMatches({ ...base, signature: "doc-research-v1:9:beef" }, topic, materialHash), false);
});

test("assertTopic trims, collapses whitespace, and enforces bounds", () => {
  assert.equal(assertTopic("  The  great   mystery "), "The great mystery");
  assert.throws(() => assertTopic("ab"), AppError);
  assert.throws(() => assertTopic("x".repeat(201)), AppError);
  assert.throws(() => assertTopic(42), AppError);
});
