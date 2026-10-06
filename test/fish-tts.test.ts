import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// This file runs in its own process. Configure GEMINI + FISH + OPENAI keys so
// all three real TTS providers are "ready", and pin the provider order via
// AUDIO_TTS_PROVIDERS. FISH_API_KEY is a throwaway value — every network call
// is replaced by a mocked globalThis.fetch, so NO real Fish/Gemini/OpenAI
// request is ever made.
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.FISH_API_KEY = "test-fish-key";
process.env.FISH_TTS_MODEL = "s2.1-pro-free";
process.env.AUDIO_TTS_PROVIDERS = "gemini,fish,openai";

const { generateNarration, audioProviderStatus, verifyAudioFile } = await import("@/lib/audio/router");
const { GeminiTtsProvider } = await import("@/lib/audio/providers/gemini-tts");
const { FishTtsProvider } = await import("@/lib/audio/providers/fish-tts");
const { OpenAiTtsProvider } = await import("@/lib/audio/providers/openai-tts");
const { config } = await import("@/lib/config");
const { AppError } = await import("@/lib/errors");

let workDir = "";
test.before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "clipforge-fish-tts-"));
});
test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});
function outPath(name: string): string {
  return path.join(workDir, name);
}

/** A fake but content-valid MP3 (starts with a real frame-sync). */
function fakeMp3(size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff; buf[1] = 0xfb; buf[2] = 0x90; buf[3] = 0x00;
  for (let i = 4; i < size; i += 1) buf[i] = (i * 7) & 0xff;
  return buf;
}
/** Copy a Buffer into a fresh Uint8Array (satisfies the Response BodyInit type). */
function toBody(buf: Buffer) {
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

type FetchCall = { url: string; init?: RequestInit };
/**
 * Replace globalThis.fetch with a URL-dispatching stub. `routes` maps a URL
 * substring to a handler. Any call that matches no route throws (so an
 * accidental real request is impossible and an unexpected provider call is
 * caught).
 */
function mockFetch(routes: Record<string, (call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init };
    calls.push(call);
    const match = Object.entries(routes).find(([key]) => url.includes(key));
    if (!match) throw new Error(`Unexpected fetch in test: ${url}`);
    return match[1](call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
    fishCalls: () => calls.filter((c) => c.url.includes(config.fishTtsBaseUrl)),
    geminiCalls: () => calls.filter((c) => c.url.includes(config.geminiBaseUrl)),
    openaiCalls: () => calls.filter((c) => c.url.includes(config.openaiTtsBaseUrl)),
  };
}

const okVerify = async (_filePath: string) => ({ durationSec: 6.2, bytes: 4096 });

test("A. the Fish provider sends the documented request and writes the returned audio bytes", async () => {
  const mp3 = fakeMp3(5000);
  const { restore, fishCalls } = mockFetch({
    [config.fishTtsBaseUrl]: () => new Response(toBody(mp3), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
  });
  const target = outPath("fish-a.mp3");
  try {
    const provider = new FishTtsProvider();
    assert.equal(provider.ready, true, "Fish is ready when FISH_API_KEY is set");
    const result = await provider.generateNarration({ text: "The crew argues about the failing pump.", outPath: target });

    const calls = fishCalls();
    assert.equal(calls.length, 1, "exactly one Fish request");
    const call = calls[0];
    assert.equal(call.url, `${config.fishTtsBaseUrl}/v1/tts`);
    assert.equal(call.init?.method, "POST");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["Authorization"], `Bearer ${config.fishApiKey}`, "key sent as Bearer token");
    assert.match(headers["Content-Type"] ?? "", /application\/json/);
    assert.equal(headers["model"], "s2.1-pro-free", "the configured model is sent in the model header");
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    assert.equal(body.text, "The crew argues about the failing pump.", "narration text is the request text");
    assert.equal(body.format, "mp3");
    assert.ok(!("reference_id" in body), "no reference_id when no Fish voice is configured");

    // The API key must never leak into the request body.
    assert.ok(!String(call.init?.body).includes(config.fishApiKey), "API key is never in the body");
    // The exact returned bytes are written to the provider's outPath.
    assert.ok(existsSync(target), "audio file written");
    assert.deepEqual(readFileSync(target), mp3, "bytes preserved verbatim");
    assert.equal(result.providerId, "fish");
    assert.equal(result.filePath, target);
    assert.equal(result.bytes, mp3.length);
    assert.match(result.contentType ?? "", /audio/);
  } finally {
    restore();
  }
});

test("A2. an explicit voice is sent as Fish reference_id; raw PCM is normalized to a valid WAV", async () => {
  const pcm = Buffer.alloc(2000, 0xab); // bare PCM — no container magic
  const { restore } = mockFetch({
    [config.fishTtsBaseUrl]: () => new Response(toBody(pcm), { status: 200, headers: { "Content-Type": "audio/L16;rate=44100" } }),
  });
  const target = outPath("fish-a2.wav");
  try {
    const result = await new FishTtsProvider().generateNarration({ text: "A short line.", outPath: target, voice: "voice-model-123" });
    const written = readFileSync(target);
    assert.equal(written.subarray(0, 4).toString("ascii"), "RIFF", "raw PCM wrapped in a RIFF container");
    assert.equal(written.subarray(8, 12).toString("ascii"), "WAVE", "...that is a valid WAVE file");
    assert.equal(result.bytes, 44 + pcm.length, "44-byte WAV header + raw samples");
    assert.equal(result.contentType, "audio/wav");
    assert.equal(result.voice, "voice-model-123", "the explicit voice becomes the reference_id/voice");
  } finally {
    restore();
  }
});

test("B. with AUDIO_TTS_PROVIDERS=gemini,fish,openai a Gemini 503 falls through to Fish (registry + ordering + bounded retry)", async () => {
  const mp3 = fakeMp3();
  const { restore, geminiCalls } = mockFetch({
    [config.geminiBaseUrl]: () => new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }),
    [config.fishTtsBaseUrl]: () => new Response(toBody(mp3), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
  });
  const target = outPath("fish-b.mp3");
  try {
    // No providersOverride: the router resolves buildTtsProviders() from the
    // AUDIO_TTS_PROVIDERS config, so this also proves the "fish" id maps to the
    // real FishTtsProvider in the existing registry.
    const result = await generateNarration({ text: "Fallback narration for the Gemini-to-Fish test.", outPath: target, verifyOverride: okVerify, jobId: "fish-test" });
    assert.equal(result.providerId, "fish", "Gemini 503 → Fish is used");
    assert.ok(geminiCalls().length >= 1, "Gemini was attempted before Fish");
    assert.equal(readFileSync(target).length, mp3.length, "Fish's audio is what lands on disk");
  } finally {
    restore();
  }
});

test("C. a Fish failure lets the router continue to the next configured provider (OpenAI)", async () => {
  const mp3 = fakeMp3();
  const { restore, fishCalls, openaiCalls } = mockFetch({
    [config.fishTtsBaseUrl]: () => new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401, headers: { "Content-Type": "application/json" } }),
    [config.openaiTtsBaseUrl]: () => new Response(toBody(mp3), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
  });
  const target = outPath("fish-c.mp3");
  try {
    const result = await generateNarration({
      text: "Fish fails so OpenAI must take over.",
      outPath: target,
      providersOverride: [new FishTtsProvider(), new OpenAiTtsProvider()],
      verifyOverride: okVerify,
      jobId: "fish-test",
    });
    assert.equal(result.providerId, "openai", "after a Fish failure the router reaches the later provider");
    assert.ok(fishCalls().length >= 1, "Fish was attempted first");
    assert.ok(openaiCalls().length >= 1, "OpenAI was attempted after Fish");
  } finally {
    restore();
  }
});

test("D. Fish returning empty or non-audio audio is rejected by the router and it continues to the next provider", async () => {
  // D1: HTTP 200 with a zero-byte body.
  {
    const mp3 = fakeMp3();
    const { restore, fishCalls } = mockFetch({
      [config.fishTtsBaseUrl]: () => new Response(new Uint8Array(0), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
      [config.openaiTtsBaseUrl]: () => new Response(toBody(mp3), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    });
    const target = outPath("fish-d1.mp3");
    try {
      const result = await generateNarration({
        text: "Empty Fish body must not be accepted as narration.",
        outPath: target,
        providersOverride: [new FishTtsProvider(), new OpenAiTtsProvider()],
        verifyOverride: okVerify,
        jobId: "fish-test",
      });
      assert.equal(result.providerId, "openai", "empty Fish audio is rejected; OpenAI provides the narration");
      assert.ok(fishCalls().length >= 1, "Fish was attempted");
    } finally {
      restore();
    }
  }
  // D2: HTTP 200 with a non-audio (JSON) body.
  {
    const mp3 = fakeMp3();
    const { restore, fishCalls } = mockFetch({
      [config.fishTtsBaseUrl]: () => new Response(JSON.stringify({ error: "boom" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      [config.openaiTtsBaseUrl]: () => new Response(toBody(mp3), { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    });
    const target = outPath("fish-d2.mp3");
    try {
      const result = await generateNarration({
        text: "Non-audio Fish body must not be accepted as narration.",
        outPath: target,
        providersOverride: [new FishTtsProvider(), new OpenAiTtsProvider()],
        verifyOverride: okVerify,
        jobId: "fish-test",
      });
      assert.equal(result.providerId, "openai", "non-audio Fish payload is rejected; OpenAI provides the narration");
      assert.ok(fishCalls().length >= 1, "Fish was attempted");
    } finally {
      restore();
    }
  }
});

test("D3. the unchanged existing verifyAudioFile still rejects a truncated (<512B) file — no ffprobe needed for that gate", async () => {
  const tiny = outPath("fish-tiny.mp3");
  writeFileSync(tiny, Buffer.alloc(128, 0xff)); // far below the 512-byte floor
  await assert.rejects(
    () => verifyAudioFile(tiny),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.kind, "audio_error");
      assert.match(error.message, /missing or empty/);
      return true;
    },
  );
});

test("F. audioProviderStatus reports Fish as a ready TTS provider (no network)", () => {
  const status = audioProviderStatus();
  const fish = status.tts.find((p) => p.id === "fish");
  assert.ok(fish, "fish appears in the TTS readiness report");
  assert.equal(fish?.ready, true, "Fish is ready when FISH_API_KEY is configured");
  const order = status.tts.map((p) => p.id);
  assert.ok(order.includes("gemini") && order.includes("openai"), "existing providers remain reported");
});
