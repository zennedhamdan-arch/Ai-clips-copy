import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { audioProviderStatus, generateNarration } from "@/lib/audio/router";
import type { TtsProvider } from "@/lib/audio/types";

let workDir = "";

test.before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "clipforge-audio-test-"));
});

test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function outPath(name: string): string {
  return path.join(workDir, name);
}

function fakeTts(id: string, behavior: (attempt: number) => void): TtsProvider & { attempts: number } {
  let attempts = 0;
  const provider: TtsProvider & { attempts: number } = {
    id,
    label: `fake-${id}`,
    ready: true,
    attempts: 0,
    async generateNarration(options: { outPath: string }) {
      attempts += 1;
      provider.attempts = attempts;
      behavior(attempts);
      if (!existsSync(options.outPath)) await writeFile(options.outPath, "x".repeat(1024));
      return {
        providerId: id,
        filePath: options.outPath,
        bytes: statSync(options.outPath).size,
        contentType: "audio/mpeg",
      };
    },
  };
  return provider;
}

const okVerify = async (_filePath: string) => ({ durationSec: 6.2, bytes: 1024 });

test("narration retries a transient provider failure, then succeeds", async () => {
  const target = outPath("transient.mp3");
  const flaky = fakeTts("flaky", (attempt) => {
    if (attempt === 1) throw new AppError("audio_error", "upstream 503", { status: 503, retryable: true });
  });
  const result = await generateNarration({
    text: "A short narration for the retry test.",
    outPath: target,
    providersOverride: [flaky],
    verifyOverride: okVerify,
    jobId: "test-job",
  });
  assert.equal(flaky.attempts, 2);
  assert.equal(result.providerId, "flaky");
  assert.equal(result.durationSec, 6.2);
  assert.ok(existsSync(target));
});

test("narration skips a non-transient failure straight to the next provider", async () => {
  const target = outPath("fallback.mp3");
  const bad = fakeTts("bad-key", () => {
    throw new AppError("missing_api_key", "bad api key", { status: 401, providerStatus: 401, retryable: false });
  });
  const good = fakeTts("good", () => undefined);
  const result = await generateNarration({
    text: "Fallback narration text for the provider router test.",
    outPath: target,
    providersOverride: [bad, good],
    verifyOverride: okVerify,
    jobId: "test-job",
  });
  assert.equal(bad.attempts, 1, "non-transient provider must not be retried");
  assert.equal(good.attempts, 1);
  assert.equal(result.providerId, "good");
});

test("narration reports a verified-duration mismatch as a provider failure", async () => {
  const target = outPath("mismatch.mp3");
  const lying = fakeTts("lying", () => undefined);
  await assert.rejects(
    generateNarration({
      text: "Duration mismatch should route to the next provider, which is absent.",
      outPath: target,
      providersOverride: [lying],
      verifyOverride: async () => {
        throw new AppError("audio_error", "ffprobe duration outside expected range", { retryable: false });
      },
      jobId: "test-job",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.kind, "audio_error");
      assert.equal(error.retryable, true, "all-providers-failed is retryable");
      assert.equal(error.resumeStage, "narration");
      assert.match(error.message, /lying/);
      return true;
    },
  );
});

test("narration throws a retryable audio_error when every provider fails", async () => {
  const target = outPath("all-fail.mp3");
  const one = fakeTts("one", () => {
    throw new AppError("rate_limited", "429 too many requests", { status: 429, retryable: true });
  });
  const two = fakeTts("two", () => {
    throw new Error("socket hang up");
  });
  await assert.rejects(
    generateNarration({
      text: "Every provider in this scenario fails on purpose.",
      outPath: target,
      providersOverride: [one, two],
      verifyOverride: okVerify,
      jobId: "test-job",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.kind, "audio_error");
      assert.equal(error.retryable, true);
      assert.equal(error.resumeStage, "narration");
      assert.match(error.message, /one/);
      assert.match(error.message, /two/);
      return true;
    },
  );
});

test("narration rejects empty text without calling any provider", async () => {
  const neverCalled = fakeTts("unused", () => {
    throw new Error("should not run");
  });
  await assert.rejects(
    generateNarration({
      text: "   ",
      outPath: outPath("empty.mp3"),
      providersOverride: [neverCalled],
      verifyOverride: okVerify,
      jobId: "test-job",
    }),
    (error: unknown) => error instanceof AppError && error.kind === "audio_error",
  );
  assert.equal(neverCalled.attempts, 0);
});

test("audioProviderStatus reports readiness without network access", () => {
  const status = audioProviderStatus();
  const ttsIds = status.tts.map((p) => p.id);
  const musicIds = status.music.map((p) => p.id);
  assert.ok(ttsIds.includes("gemini") && ttsIds.includes("openai"), `tts ids: ${ttsIds}`);
  assert.ok(musicIds.includes("b2") && musicIds.includes("freetouse"), `music ids: ${musicIds}`);
  const freetouse = status.music.find((p) => p.id === "freetouse");
  assert.equal(freetouse?.ready, true, "Free To Use needs no API key");
  const mock = [...status.tts, ...status.music].find((p) => p.id === "mock");
  if (!process.env.AUDIO_MOCK) assert.equal(mock, undefined, "mock providers must be hidden unless AUDIO_MOCK=1");
});
