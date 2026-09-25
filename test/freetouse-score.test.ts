import test from "node:test";
import assert from "node:assert/strict";
import { parseFreetoUseTrack, scoreFreetoUseTrack } from "@/lib/audio/providers/freetouse";

function rawTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Deep Space Drift",
    artists: [[0, { id: "a1", name: "Nebula Lab" }]],
    genre: "ambient",
    status: 1,
    is_premium: false,
    duration: 172,
    downloads: 4200,
    tags: [[0, "space"], [1, "cinematic"]],
    categories: [[0, { id: "c1", name: "Soundtracks" }]],
    tags_categories: [[0, "mystery"]],
    files: { mp3: "https://cdn.freetouse.example/deep-space.mp3" },
    ...overrides,
  };
}

test("parseFreetoUseTrack parses a full track object", () => {
  const track = parseFreetoUseTrack(rawTrack());
  assert.ok(track);
  assert.equal(track.title, "Deep Space Drift");
  assert.deepEqual(track.artists, ["Nebula Lab"]);
  assert.deepEqual(track.tags, ["space", "cinematic", "mystery"]);
  assert.equal(track.genre, "ambient");
  assert.equal(track.duration, 172);
  assert.equal(track.isPremium, false);
  assert.equal(track.mp3Url, "https://cdn.freetouse.example/deep-space.mp3");
});

test("parseFreetoUseTrack rejects inactive or incomplete tracks", () => {
  assert.equal(parseFreetoUseTrack(rawTrack({ status: 0 })), null);
  assert.equal(parseFreetoUseTrack(rawTrack({ id: undefined })), null);
  assert.equal(parseFreetoUseTrack(rawTrack({ title: "  " })), null);
  assert.equal(parseFreetoUseTrack(rawTrack({ duration: "soon" })), null);
  const noFile = parseFreetoUseTrack(rawTrack({ files: {} }));
  assert.equal(noFile?.mp3Url, null);
});

test("scoreFreetoUseTrack ranks topic matches above misses", () => {
  const matching = parseFreetoUseTrack(rawTrack({ tags: [[0, "space"]], genre: "ambient" }));
  const missing = parseFreetoUseTrack(rawTrack({ title: "Morning Coffee", tags: [[0, "jazz"]], genre: "jazz", duration: 200 }));
  assert.ok(matching && missing);
  const query = { topic: "expansions of the deep space", durationSec: 90 };
  const good = scoreFreetoUseTrack(matching, query);
  const bad = scoreFreetoUseTrack(missing, query);
  assert.ok(good > bad, `matching score ${good} should beat ${bad}`);
});

test("scoreFreetoUseTrack prefers well-sized durations for the target", () => {
  const sized = parseFreetoUseTrack(rawTrack({ duration: 150 }));
  const tooShort = parseFreetoUseTrack(rawTrack({ duration: 12 }));
  assert.ok(sized && tooShort);
  const query = { topic: "space", durationSec: 90 };
  assert.ok(scoreFreetoUseTrack(sized, query) > scoreFreetoUseTrack(tooShort, query));
});
