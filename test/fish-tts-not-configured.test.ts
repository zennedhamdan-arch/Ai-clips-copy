import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// This file runs in its own process. GEMINI is configured, but FISH_API_KEY is
// intentionally NOT set, so Fish must be treated as unconfigured and skipped
// even though it is listed in AUDIO_TTS_PROVIDERS. The single network call
// (Gemini) is mocked; no real request is made.
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.AUDIO_TTS_PROVIDERS = "gemini,fish";
delete process.env.FISH_API_KEY;
delete process.env.FISH_TTS_MODEL;

const { generateNarration, audioProviderStatus } = await import("@/lib/audio/router");
const { FishTtsProvider } = await import("@/lib/audio/providers/fish-tts");
const { config } = await import("@/lib/config");

let workDir = "";
test.before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "clipforge-fish-off-"));
});
test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});
function outPath(name: string): string {
  return path.join(workDir, name);
}

/** A content-valid MP3 the (mocked) Gemini provider will decode from base64. */
function fakeMp3(size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff; buf[1] = 0xfb; buf[2] = 0x90; buf[3] = 0x00;
  for (let i = 4; i < size; i += 1) buf[i] = (i * 7) & 0xff;
  return buf;
}

function geminiEnvelope(mp3: Buffer): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/mpeg", data: mp3.toString("base64") } }] } }],
  });
}

type FetchCall = { url: string };
function mockFetch(routes: Record<string, (call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url };
    calls.push(call);
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    if (!match) throw new Error(`Unexpected fetch in test: ${url}`);
    return match[1](call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okVerify = async (_filePath: string) => ({ durationSec: 6.2, bytes: 4096 });

test("E1. FishTtsProvider.ready is false when FISH_API_KEY is not configured", () => {
  assert.equal(config.fishApiKey, "", "no Fish key in this process");
  assert.equal(new FishTtsProvider().ready, false, "Fish is not ready without a key");
});

test("E2. the router skips the unconfigured Fish provider and uses the configured one (Gemini)", async () => {
  const mp3 = fakeMp3();
  const { calls, restore } = mockFetch({
    [config.geminiBaseUrl]: () => new Response(geminiEnvelope(mp3), { status: 200, headers: { "Content-Type": "application/json" } }),
    // If Fish were (wrongly) selected, this route would match and we assert it
    // was never called.
    [config.fishTtsBaseUrl]: () => new Response(new Uint8Array(0), { status: 200 }),
  });
  const target = outPath("fish-off.mp3");
  try {
    // No providersOverride: the router resolves buildTtsProviders() from
    // AUDIO_TTS_PROVIDERS=gemini,fish and must drop the unready Fish entry.
    const result = await generateNarration({ text: "Fish is not configured here.", outPath: target, verifyOverride: okVerify, jobId: "fish-off" });
    assert.equal(result.providerId, "gemini", "Gemini (configured) is used, not the unconfigured Fish");
    assert.equal(calls.filter((c) => c.url.includes(config.fishTtsBaseUrl)).length, 0, "no request is ever sent to Fish when it is not configured");
    assert.ok(existsSync(target), "Gemini produced the narration file");
  } finally {
    restore();
  }
});

test("E3. audioProviderStatus reports Fish as present but not ready (no network)", () => {
  const status = audioProviderStatus();
  const fish = status.tts.find((p) => p.id === "fish");
  assert.ok(fish, "fish appears in the TTS readiness report");
  assert.equal(fish?.ready, false, "Fish is reported not-ready when FISH_API_KEY is unset");
});
