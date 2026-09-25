import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRawPcmPayload, normalizeGeminiAudioPayload, parseGeminiAudioMime, pcm16ToWav } from "@/lib/audio/providers/gemini-tts";

let workDir = "";

test.before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "clipforge-gemini-tts-test-"));
});

test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Real 16-bit little-endian PCM (a 440 Hz sine) — the exact byte format
 *  Gemini returns for audio/L16; not a mock provider, just fixture bytes. */
function makePcm16(seconds: number, sampleRate: number, hz = 440): Buffer {
  const frames = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5 * 32767);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function readWavHeader(file: string) {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "fmt ");
  const header = {
    riffSize: buf.readUInt32LE(4),
    fmtSize: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataTag: buf.subarray(36, 40).toString("ascii"),
    dataSize: buf.readUInt32LE(40),
    totalSize: buf.length,
  };
  return { header, buf };
}

async function probeWithFfprobe(file: string): Promise<{ durationSec: number; formatName: string } | "unavailable"> {
  const bin = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const run = (args: string[]): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 30_000 }, (error, stdout) => {
        if (!error) return resolve({ stdout: String(stdout), code: 0 });
        const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? -1 : 1;
        resolve({ stdout: String(stdout), code });
      });
    });
  const availability = await run(["-version"]);
  if (availability.code === -1) return "unavailable";
  const result = await run(["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", file]);
  if (result.code !== 0) throw new Error(`ffprobe failed on ${path.basename(file)} (exit ${result.code})`);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string; format_name?: string } };
  return { durationSec: Number(parsed.format?.duration ?? NaN), formatName: parsed.format?.format_name ?? "" };
}

test("raw Gemini audio/L16 payload becomes a WAV file ffprobe can read", async (t) => {
  const sampleRate = 24000;
  const pcm = makePcm16(1.0, sampleRate);
  const file = path.join(workDir, "narration-raw-0.wav");
  const result = await normalizeGeminiAudioPayload("audio/L16;rate=24000", pcm, file);

  // Container was written (not a rename): RIFF/WAVE with a correct header.
  assert.equal(result.bytes, pcm.length + 44);
  assert.equal(result.contentType, "audio/wav");
  const { header, buf } = readWavHeader(file);
  assert.equal(header.riffSize, 36 + pcm.length, "RIFF size must cover fmt+data");
  assert.equal(header.fmtSize, 16);
  assert.equal(header.audioFormat, 1, "PCM format");
  assert.equal(header.channels, 1);
  assert.equal(header.sampleRate, sampleRate, "rate from the MIME must be honored");
  assert.equal(header.byteRate, sampleRate * 2);
  assert.equal(header.blockAlign, 2);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.dataTag, "data");
  assert.equal(header.dataSize, pcm.length);
  assert.equal(header.totalSize, 44 + pcm.length);
  // The PCM samples are preserved verbatim after the 44-byte header.
  assert.ok(buf.subarray(44).equals(pcm), "PCM payload must be untouched inside the WAV");

  // Prove ffprobe can read it — where ffprobe exists (deployment host / CI).
  const probe = await probeWithFfprobe(file);
  if (probe === "unavailable") {
    t.skip("ffprobe not installed in this environment; structural WAV validation above covers the container");
    return;
  }
  assert.ok(/wav/i.test(probe.formatName), `ffprobe format should be wav, got "${probe.formatName}"`);
  assert.ok(Number.isFinite(probe.durationSec), "ffprobe must report a finite duration");
  assert.ok(Math.abs(probe.durationSec - 1.0) < 0.1, `ffprobe duration ~1s, got ${probe.durationSec}`);
});

test("sample rate from the MIME is honored (non-default 22050 Hz)", async () => {
  const pcm = makePcm16(0.5, 22050);
  const file = path.join(workDir, "rate-22050.wav");
  await normalizeGeminiAudioPayload("audio/L16;rate=22050", pcm, file);
  const { header } = readWavHeader(file);
  assert.equal(header.sampleRate, 22050);
  assert.equal(header.byteRate, 22050 * 2);
});

test("an already-valid container is preserved byte-for-byte", async () => {
  // A valid WAV container (built from real PCM) declared as audio/wav.
  const pcm = makePcm16(0.25, 24000);
  const container = pcm16ToWav(pcm, 24000, 1);
  const file = path.join(workDir, "passthrough.wav");
  const result = await normalizeGeminiAudioPayload("audio/wav", container, file);
  assert.equal(result.bytes, container.length);
  assert.ok(readFileSync(file).equals(container), "container bytes must be written unchanged");

  // An opaque non-PCM container (ID3-tagged MP3-style prefix) is preserved too.
  const mp3ish = Buffer.concat([Buffer.from("ID3"), Buffer.from([0x03, 0x00, 0x00]), makePcm16(0.1, 8000)]);
  const mp3File = path.join(workDir, "passthrough.mp3");
  await normalizeGeminiAudioPayload("audio/mpeg", mp3ish, mp3File);
  assert.ok(readFileSync(mp3File).equals(mp3ish), "non-PCM container bytes must be written unchanged");
});

test("MIME parsing: subtype, explicit rate, and safe defaults", () => {
  assert.deepEqual(parseGeminiAudioMime("audio/L16;rate=24000"), { subtype: "l16", rate: 24000 });
  assert.deepEqual(parseGeminiAudioMime("audio/L16"), { subtype: "l16", rate: 24000 });
  assert.deepEqual(parseGeminiAudioMime(undefined), { subtype: "", rate: 24000 });
  assert.deepEqual(parseGeminiAudioMime("audio/wav"), { subtype: "wav", rate: 24000 });
  assert.deepEqual(parseGeminiAudioMime("audio/pcm;rate=abc"), { subtype: "pcm", rate: 24000 });
  assert.equal(isRawPcmPayload("l16", Buffer.alloc(10)), true);
  assert.equal(isRawPcmPayload("wav", Buffer.alloc(10)), false);
  assert.equal(isRawPcmPayload("", Buffer.from("ID3\0\0\0")), false, "container magic → not raw PCM");
  assert.equal(isRawPcmPayload("", Buffer.alloc(10, 0x01)), true, "unknown MIME + no magic → raw PCM");
});
