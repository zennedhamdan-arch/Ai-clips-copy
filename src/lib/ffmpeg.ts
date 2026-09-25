import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors";

/** Docker installs system binaries; local hosts may override their paths. */
function resolveBinary(kind: "ffmpeg" | "ffprobe"): string {
  return process.env[kind === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"]?.trim() || kind;
}

/**
 * Resolved lazily (not at import) so a misconfigured host still boots and the
 * health endpoint can report the problem instead of crashing every route.
 */
export function ffmpegBin(): string {
  return resolveBinary("ffmpeg");
}

export function ffprobeBin(): string {
  return resolveBinary("ffprobe");
}


export type ProbeResult = {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  bitrate: number | null;
  /** Container format reported by ffprobe (e.g. mp3, wav, mov,mp4). */
  formatName: string | null;
  /** Audio-only details used by the Music Library metadata probe. */
  sampleRate: number | null;
  channels: number | null;
};

function run(
  bin: string,
  args: string[],
  options: {
    timeoutSec?: number;
    onStderr?: (chunk: string) => void;
    capture?: boolean;
    cwd?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = options.timeoutSec
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(
              new AppError(
                "ffmpeg_error",
                `${path.basename(bin)} timed out after ${options.timeoutSec}s.`,
                { detail: `args: ${args.join(" ").slice(0, 500)}` },
              ),
            );
          }
        }, options.timeoutSec * 1000)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      if (options.capture !== false) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (options.capture !== false) stderr += text;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      options.onStderr?.(text);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new AppError("ffmpeg_error", `Could not start ${path.basename(bin)}: ${err.message}`, {
          detail: err.stack,
        }),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(
          new AppError(
            "ffmpeg_error",
            `${path.basename(bin)} exited with code ${code ?? signal}. ${lastMeaningfulLine(stderr)}`,
            { detail: tail || `args: ${args.join(" ").slice(0, 800)}` },
          ),
        );
      }
    });
  });
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        /error|invalid|no such|corrupt|moov atom|not found|failed|unable|does not match/i.test(
          l,
        ) && !/^frame=/.test(l),
    );
  return lines.length ? `Last error: ${lines[lines.length - 1].slice(0, 300)}` : "";
}

/** Verify the binaries actually run (fails loudly on broken deployments). */
let binaryCheck: Promise<{ ffmpeg: string; ffprobe: string }> | null = null;
export function checkBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (!binaryCheck) {
    binaryCheck = (async () => {
      const ff = await run(ffmpegBin(), ["-hide_banner", "-version"], { capture: true });
      const fp = await run(ffprobeBin(), ["-hide_banner", "-version"], { capture: true });
      return {
        ffmpeg: ff.stdout.split("\n")[0]?.trim() ?? "ffmpeg",
        ffprobe: fp.stdout.split("\n")[0]?.trim() ?? "ffprobe",
      };
    })().catch((err) => {
      binaryCheck = null;
      throw err;
    });
  }
  return binaryCheck;
}

/** Run ffmpeg with raw args — used by the deployment self-test endpoint. */
export async function runFfmpegArgs(args: string[]): Promise<void> {
  await run(ffmpegBin(), args, { capture: true, timeoutSec: 300 });
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new AppError("unsupported_media", "Video file is missing on disk before probing.");
  }
  if (stat.size === 0) {
    throw new AppError("unsupported_media", "Video file is empty (0 bytes).");
  }

  const { stdout } = await run(
    ffprobeBin(),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,avg_frame_rate,duration,sample_rate,channels",
      "-show_entries",
      "format=duration,size,bit_rate,format_name",
      "-of",
      "json",
      filePath,
    ],
    { capture: true, timeoutSec: 120 },
  );

  let parsed: {
    streams?: Array<Record<string, string | number | null>>;
    format?: Record<string, string | number | null>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError("unsupported_media", "Could not read video metadata (ffprobe gave no JSON).");
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video && !audio) {
    throw new AppError(
      "unsupported_media",
      "This file has no playable video or audio streams. It may be corrupted or an unsupported container.",
    );
  }

  const formatDuration = Number(parsed.format?.duration ?? 0);
  const streamDuration = Number(video?.duration ?? audio?.duration ?? 0);
  const durationSec = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : Number.isFinite(streamDuration)
      ? streamDuration
      : 0;

  if (!durationSec) {
    throw new AppError(
      "unsupported_media",
      "Could not determine the video duration — the file is likely truncated or still downloading.",
    );
  }

  const fpsRaw = String(video?.avg_frame_rate ?? "0/0");
  const [num, den] = fpsRaw.split("/").map(Number);
  const fps = den ? num / den : 0;

  return {
    durationSec,
    width: video?.width ? Number(video.width) : null,
    height: video?.height ? Number(video.height) : null,
    fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ? String(video.codec_name) : null,
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
    sizeBytes: stat.size,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    formatName: parsed.format?.format_name ? String(parsed.format.format_name) : null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ? Number(audio.channels) : null,
  };
}

/**
 * Extract 16kHz mono FLAC audio (small + lossless enough for Whisper).
 * Optionally only a slice, used for chunking long videos.
 */
export async function extractAudio(options: {
  input: string;
  output: string;
  startSec?: number;
  durationSec?: number;
}): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (options.startSec !== undefined) args.push("-ss", options.startSec.toFixed(3));
  args.push("-i", options.input);
  if (options.durationSec !== undefined) args.push("-t", options.durationSec.toFixed(3));
  args.push("-vn", "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "flac", options.output);
  await run(ffmpegBin(), args, { timeoutSec: 900 });
}

export type MusicEnergyAnalysis = {
  durationSec: number;
  averageDb: number | null;
  peakTimesSec: number[];
  estimatedBpm: number | null;
  vibe: string;
};

/** Lightweight half-second RMS analysis; no ML model or persistent process. */
export async function analyzeMusicEnergy(filePath: string): Promise<MusicEnergyAnalysis> {
  const durationSec = await mediaDurationSeconds(filePath);
  const samples: Array<{ time: number; db: number }> = [];
  let currentTime = 0;
  let remainder = "";
  const parseLine = (line: string) => {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time) currentTime = Number(time[1]);
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=([-\d.]+)/);
    if (rms) {
      const db = Number(rms[1]);
      if (Number.isFinite(db)) samples.push({ time: currentTime, db });
    }
  };
  await run(
    ffmpegBin(),
    [
      "-hide_banner", "-nostats", "-i", filePath,
      "-af", "aresample=16000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f", "null", "-",
    ],
    {
      capture: true,
      timeoutSec: Math.max(120, Math.round(durationSec * 2)),
      onStderr(chunk) {
        const lines = `${remainder}${chunk}`.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      },
    },
  );
  if (remainder) parseLine(remainder);
  const averageDb = samples.length ? samples.reduce((sum, sample) => sum + sample.db, 0) / samples.length : null;
  const localPeaks = samples.filter((sample, index) => {
    const previous = samples[index - 1]?.db ?? -Infinity;
    const next = samples[index + 1]?.db ?? -Infinity;
    return sample.db >= previous && sample.db > next && (averageDb === null || sample.db >= averageDb + 2.5);
  });
  const peakTimesSec: number[] = [];
  for (const peak of localPeaks) {
    if (!peakTimesSec.length || peak.time - peakTimesSec[peakTimesSec.length - 1] >= 0.35) {
      peakTimesSec.push(Number(peak.time.toFixed(3)));
    }
  }
  const intervals = peakTimesSec.slice(1).map((time, index) => time - peakTimesSec[index]).filter((value) => value >= 0.33 && value <= 2);
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : null;
  let estimatedBpm = medianInterval ? 60 / medianInterval : null;
  while (estimatedBpm && estimatedBpm < 60) estimatedBpm *= 2;
  while (estimatedBpm && estimatedBpm > 180) estimatedBpm /= 2;
  const vibe = averageDb === null ? "unknown" : averageDb > -14 ? "intense" : averageDb > -22 ? "energetic" : averageDb > -32 ? "balanced" : "calm";
  return {
    durationSec,
    averageDb: averageDb === null ? null : Number(averageDb.toFixed(2)),
    peakTimesSec: peakTimesSec.slice(0, 500),
    estimatedBpm: estimatedBpm ? Math.round(estimatedBpm) : null,
    vibe,
  };
}

export async function mediaDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await run(
    ffprobeBin(),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { capture: true, timeoutSec: 60 },
  );
  const value = Number(stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

export type RenderProgress = (ratio: number) => void;

/**
 * Cut + reframe + burn subtitles in a single ffmpeg pass (low disk, low CPU).
 */
export async function renderVerticalClip(options: {
  input: string;
  output: string;
  startSec: number;
  endSec: number;
  subtitlePath?: string;
  subtitlesEnabled: boolean;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  crf: number;
  preset: string;
  audioBitrateK: number;
  hasAudio: boolean;
  framingMode?: "crop" | "fit";
  music?: { input: string; startOffsetSec: number; volume?: number };
  soundEffects?: Array<{ input: string; atSec?: number; volume?: number }>;
  onProgress?: RenderProgress;
}): Promise<void> {
  const duration = Math.max(0.5, options.endSec - options.startSec);
  const videoFilters = options.framingMode === "fit"
    ? [
        `scale=${options.targetWidth}:${options.targetHeight}:force_original_aspect_ratio=decrease`,
        `pad=${options.targetWidth}:${options.targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
        `fps=${options.targetFps}`,
        "setsar=1",
      ]
    : [
        `scale=${options.targetWidth}:${options.targetHeight}:force_original_aspect_ratio=increase`,
        `crop=${options.targetWidth}:${options.targetHeight}:(iw-ow)/2:(ih-oh)/2`,
        `fps=${options.targetFps}`,
        "setsar=1",
      ];
  if (options.subtitlesEnabled && options.subtitlePath) {
    videoFilters.push(`ass=${quoteFilterPath(options.subtitlePath)}:fontsdir=${quoteFilterPath(fontsDir())}`);
  }

  const args = [
    "-hide_banner", "-loglevel", "warning", "-stats", "-y",
    "-ss", options.startSec.toFixed(3), "-i", options.input,
  ];
  let nextInputIndex = 1;
  let musicInputIndex: number | null = null;
  if (options.music) {
    musicInputIndex = nextInputIndex++;
    args.push(
      "-stream_loop", "-1",
      "-ss", Math.max(0, options.music.startOffsetSec).toFixed(3),
      "-i", options.music.input,
    );
  }
  const effectInputs = (options.soundEffects ?? []).slice(0, 4).map((effect) => ({
    ...effect,
    inputIndex: nextInputIndex++,
  }));
  for (const effect of effectInputs) args.push("-i", effect.input);
  args.push("-t", duration.toFixed(3));

  const hasAddedAudio = musicInputIndex !== null || effectInputs.length > 0;
  if (hasAddedAudio) {
    const audioFilters = [`[0:v]${videoFilters.join(",")}[vout]`];
    const mixInputs: string[] = [];
    if (options.hasAudio && musicInputIndex !== null) {
      audioFilters.push("[0:a:0]aresample=44100,asetpts=PTS-STARTPTS,asplit=2[speechmix][speechside]");
      mixInputs.push("[speechmix]");
    } else if (options.hasAudio) {
      audioFilters.push("[0:a:0]aresample=44100,asetpts=PTS-STARTPTS[speechmix]");
      mixInputs.push("[speechmix]");
    }
    if (musicInputIndex !== null && options.music) {
      const volume = Math.max(0.03, Math.min(0.5, options.music.volume ?? 0.18));
      const fadeOutStart = Math.max(0, duration - 1);
      audioFilters.push(
        `[${musicInputIndex}:a]aresample=44100,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)},afade=t=in:st=0:d=${Math.min(0.8, duration / 3).toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${Math.min(1, duration).toFixed(3)}[music]`,
      );
      if (options.hasAudio) {
        audioFilters.push("[music][speechside]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=400[ducked]");
        mixInputs.push("[ducked]");
      } else {
        mixInputs.push("[music]");
      }
    }
    effectInputs.forEach((effect, index) => {
      const atSec = Math.max(0, Math.min(duration - 0.05, effect.atSec ?? 0));
      const delayMs = Math.round(atSec * 1000);
      const volume = Math.max(0.03, Math.min(1, effect.volume ?? 0.3));
      audioFilters.push(
        `[${effect.inputIndex}:a]aresample=44100,atrim=duration=${Math.max(0.05, duration - atSec).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${volume.toFixed(3)},apad,atrim=duration=${duration.toFixed(3)}[sfx${index}]`,
      );
      mixInputs.push(`[sfx${index}]`);
    });
    audioFilters.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]`,
    );
    args.push("-filter_complex", audioFilters.join(";"), "-map", "[vout]", "-map", "[aout]");
  } else {
    args.push("-vf", videoFilters.join(","), "-map", "0:v:0");
    if (options.hasAudio) args.push("-map", "0:a:0?");
    else args.push("-an");
  }

  if (options.hasAudio || hasAddedAudio) {
    args.push("-c:a", "aac", "-b:a", `${options.audioBitrateK}k`, "-ar", "44100", "-ac", "2");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    options.output,
  );

  await run(ffmpegBin(), args, {
    timeoutSec: Math.max(300, Math.round(duration * 12)),
    onStderr: (chunk) => {
      if (!options.onProgress) return;
      const matches = chunk.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g);
      let last = -1;
      for (const m of matches) {
        const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        last = Math.min(1, seconds / duration);
      }
      if (last >= 0) options.onProgress(last);
    },
  });
}

/** Add music to an already-rendered clip without touching/re-encoding its video stream. */
export async function mixPostRenderMusic(options: {
  clipInput: string;
  musicInput: string;
  output: string;
  durationSec: number;
  clipHasAudio: boolean;
  volume?: number;
  onProgress?: (ratio: number) => void;
}): Promise<void> {
  const duration = Math.max(0.1, options.durationSec);
  const volume = Math.max(0.01, Math.min(0.5, options.volume ?? 0.12));
  const fadeIn = Math.min(0.8, duration / 3);
  const fadeOut = Math.min(1, duration / 3);
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const args = ["-hide_banner", "-loglevel", "warning", "-stats", "-y", "-i", options.clipInput,
    "-stream_loop", "-1", "-i", options.musicInput, "-t", duration.toFixed(3)];
  const music = `[1:a:0]aresample=44100,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)},afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}[music]`;
  const filter = options.clipHasAudio
    ? `${music};[0:a:0]aresample=44100,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration.toFixed(3)}[speech];[speech][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]`
    : `${music};[music]alimiter=limit=0.95[aout]`;
  args.push("-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", options.output);
  await run(ffmpegBin(), args, {
    timeoutSec: Math.max(180, Math.round(duration * 6)),
    onStderr: (chunk) => {
      if (!options.onProgress) return;
      for (const match of chunk.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        options.onProgress(Math.min(1, seconds / duration));
      }
    },
  });
}

function quoteFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function fontsDir(): string {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
    "/usr/share/fonts",
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return "/usr/share/fonts";
}

/**
 * Transcode any decoded audio (WAV/L16/FLAC/MP3) to 44.1kHz stereo MP3.
 * Used to normalize narration files so every job stores one consistent format.
 */
export async function transcodeAudio(options: { input: string; output: string; bitrateK?: number }): Promise<void> {
  await run(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", options.input,
    "-c:a", "libmp3lame", "-b:a", `${options.bitrateK ?? 128}k`, "-ar", "44100", "-ac", "2",
    options.output,
  ], { capture: true, timeoutSec: 300 });
}

/**
 * Concatenate same-encoding segments losslessly (concat demuxer + -c copy).
 * All segments must share codec/resolution/fps — the pipelines produce them
 * with identical render settings.
 */
export async function concatVideos(options: { inputs: string[]; output: string; listFile: string }): Promise<void> {
  if (!options.inputs.length) throw new AppError("ffmpeg_error", "No segments were provided for concatenation.");
  const list = options.inputs.map((input) => `file '${input.replace(/'/g, "'\\''")}'`).join("\n");
  await fsp.writeFile(options.listFile, `${list}\n`, "utf8");
  await run(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", options.listFile,
    "-c", "copy",
    options.output,
  ], { capture: true, timeoutSec: 900 });
}

/**
 * Final mix for narrated videos (Movie Explainer / Documentary): the body
 * video stream is COPIED (no re-encode — cheap on the small Render instance)
 * while narration parts are delayed to their section offsets and optionally
 * ducked under a background music bed.
 */
export async function composeFinalShort(options: {
  body: string;
  output: string;
  durationSec: number;
  narrationParts: Array<{ input: string; startSec: number }>;
  music?: { input: string; volume?: number } | null;
  onProgress?: (ratio: number) => void;
}): Promise<void> {
  const duration = Math.max(0.5, options.durationSec);
  const args: string[] = ["-hide_banner", "-loglevel", "warning", "-stats", "-y", "-i", options.body];
  for (const part of options.narrationParts) args.push("-i", part.input);
  let musicIndex: number | null = null;
  if (options.music) {
    musicIndex = 1 + options.narrationParts.length;
    args.push("-stream_loop", "-1", "-i", options.music.input);
  }

  const filters: string[] = [];
  const mixInputs: string[] = [];
  options.narrationParts.forEach((part, index) => {
    const inputIndex = 1 + index;
    const delayMs = Math.round(Math.max(0, part.startSec) * 1000);
    filters.push(
      `[${inputIndex}:a]aresample=44100,asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[narr${index}]`,
    );
    mixInputs.push(`[narr${index}]`);
  });
  if (musicIndex !== null && options.music) {
    const volume = Math.max(0.03, Math.min(0.4, options.music.volume ?? 0.16));
    const fadeOutStart = Math.max(0, duration - 1.2);
    filters.push(
      `[${musicIndex}:a]aresample=44100,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)},afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${Math.min(1.2, duration).toFixed(3)}[music]`,
    );
    mixInputs.push("[music]");
  }
  if (!mixInputs.length) {
    // Video-only fallback (should not happen for narrated pipelines).
    args.push("-c", "copy", options.output);
    await run(ffmpegBin(), args, { timeoutSec: 300 });
    return;
  }
  filters.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]`,
  );
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-t", duration.toFixed(3),
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    options.output,
  );
  await run(ffmpegBin(), args, {
    timeoutSec: Math.max(300, Math.round(duration * 6)),
    onStderr: (chunk) => {
      if (!options.onProgress) return;
      for (const match of chunk.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        options.onProgress(Math.min(1, seconds / duration));
      }
    },
  });
}

/**
 * Documentary scene composite: pad/trim the generated scene card to the exact
 * scene duration (freezing the last frame if the narration ran longer) and
 * mix the narration in. Re-encodes once — the card is a cheap gradient source.
 */
export async function composeScene(options: {
  card: string;
  cardDurationSec: number;
  narration: string;
  output: string;
  finalDurationSec: number;
  crf?: number;
  preset?: string;
}): Promise<void> {
  const duration = Math.max(0.5, options.finalDurationSec);
  const cloneDuration = Math.max(0, duration - (options.cardDurationSec || 0) - 0.05);
  const filters = [
    `[0:v]tpad=stop_mode=clone:stop_duration=${cloneDuration.toFixed(3)},trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[v]`,
    `[1:a]aresample=44100,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration.toFixed(3)}[a]`,
  ].join(";");
  await run(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", options.card,
    "-i", options.narration,
    "-filter_complex", filters,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", options.preset ?? "veryfast", "-crf", String(options.crf ?? 23),
    "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    options.output,
  ], { capture: true, timeoutSec: Math.max(240, Math.round(duration * 10)) });
}

/**
 * Escape arbitrary text for FFmpeg's `drawtext` `text` option.
 *
 * Two layers must be satisfied:
 *   1. Filtergraph level — inside the -vf string the characters `'` (quote),
 *      `\` (escape), `:` (option separator), `,` (filter separator), `;`
 *      (filterchain separator) and `[`/`]` (link labels) are structural; each
 *      occurrence is escaped with a backslash.
 *   2. drawtext text expansion — a `%` starts a `%{...}` expansion, so a
 *      literal percent must be doubled to `%%`.
 *
 * Newlines fold into spaces (card titles are single-line) and the text is
 * truncated BEFORE escaping so an escape sequence can never be cut in half.
 * Returns "" when nothing renderable remains — callers must then skip the
 * drawtext filter entirely, because FFmpeg rejects an empty `text` value with
 * "Either text, a valid file, a timecode or text source must be provided".
 */
export function escapeDrawText(raw: string | null | undefined, maxLength = 90): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "%%");
}

/**
 * Build one fully-escaped `drawtext=...` filter from its parts (no raw
 * interpolation of user text). Returns null when the text is empty so the
 * caller never emits an invalid `text=` option. `fontFile` is included only
 * when a verified path is provided (see drawTextFontFile).
 */
export function buildDrawTextFilter(options: {
  text: string | null | undefined;
  color: string;
  size: number;
  x: string;
  y: string;
  fontFile?: string | null;
  maxLength?: number;
}): string | null {
  const text = escapeDrawText(options.text, options.maxLength);
  if (!text) return null;
  const parts: string[] = [];
  if (options.fontFile) parts.push(`fontfile=${quoteFilterPath(options.fontFile)}`);
  parts.push(`fontcolor=${options.color}`);
  parts.push(`fontsize=${Math.max(1, Math.round(options.size))}`);
  parts.push(`x=${options.x}`);
  parts.push(`y=${options.y}`);
  parts.push(`text=${text}`);
  return `drawtext=${parts.join(":")}`;
}

/**
 * Build the full -vf chain for a documentary scene card: optional title,
 * optional subtitle, the CLIPFORGE watermark, and the fade in/out. Text
 * filters are skipped entirely when their text is empty; the gradient input
 * and encoding parameters stay in generateSceneCard.
 */
export function buildSceneCardVf(options: {
  title: string | null | undefined;
  subtitle?: string | null;
  fontFile?: string | null;
  durationSec: number;
}): string {
  const duration = Math.max(2, options.durationSec);
  const filters: string[] = [];
  const title = buildDrawTextFilter({ text: options.title, color: "white", size: 96, x: "(w-text_w)/2", y: "h*0.30", fontFile: options.fontFile });
  if (title) filters.push(title);
  const subtitle = buildDrawTextFilter({ text: options.subtitle, color: "white@0.8", size: 48, x: "(w-text_w)/2", y: "h*0.30+170", fontFile: options.fontFile });
  if (subtitle) filters.push(subtitle);
  const watermark = buildDrawTextFilter({ text: "CLIPFORGE DOCUMENTARY", color: "white@0.45", size: 34, x: "w-360", y: "h-170", fontFile: options.fontFile });
  if (watermark) filters.push(watermark);
  const fadeOutStart = Math.max(0, duration - 1);
  filters.push(`fade=t=in:st=0:d=1.1`);
  filters.push(`fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${Math.min(1, duration / 3).toFixed(3)}`);
  return filters.join(",");
}

/** First existing regular file among the known font candidates, else null. */
export function drawTextFontFile(): string | null {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  ];
  for (const candidate of candidates) {
    try {
      // Verify it is a real regular file before referencing it via fontfile —
      // a stale or directory path makes drawtext fail at runtime.
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Generate a documentary scene visual entirely with FFmpeg (no external image
 * API): an animated gradient canvas plus title text, derived deterministically
 * from the scene's visual prompt. This is the "procedural" asset generator —
 * the scene's visualPrompt is persisted so a real image provider can replace
 * it later without touching the pipeline.
 */
export async function generateSceneCard(options: {
  output: string;
  durationSec: number;
  /** May be empty/undefined (e.g. corrupted checkpoint) — the title filter is
   *  then skipped instead of emitting invalid FFmpeg. */
  title?: string | null;
  subtitle?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  palette: [string, string];
}): Promise<void> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fps = options.fps ?? 30;
  const duration = Math.max(2, options.durationSec);
  const [c0, c1] = options.palette;
  // drawtext filters are built via buildSceneCardVf: user text is escaped,
  // empty text is skipped entirely, and fontfile is only used when the font
  // path was verified to exist.
  const vf = buildSceneCardVf({
    title: options.title,
    subtitle: options.subtitle,
    fontFile: drawTextFontFile(),
    durationSec: duration,
  });
  await run(ffmpegBin(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", `gradients=s=${width}x${height}:d=${duration.toFixed(3)}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${width}:y1=${height}:nb_colors=2:type=linear:speed=0.04`,
    "-vf", vf,
    "-t", duration.toFixed(3),
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-movflags", "+faststart",
    options.output,
  ], { capture: true, timeoutSec: Math.max(240, Math.round(duration * 10)) });
}

/** Pull a still frame so the UI can show a poster for each clip. */
export async function extractPoster(options: {
  input: string;
  output: string;
  atSec: number;
  width: number;
}): Promise<boolean> {
  try {
    await run(
      ffmpegBin(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        Math.max(0, options.atSec).toFixed(3),
        "-i",
        options.input,
        "-frames:v",
        "1",
        "-vf",
        `scale=${options.width ?? 270}:-2`,
        "-q:v",
        "4",
        options.output,
      ],
      { capture: true, timeoutSec: 120 },
    );
    return fs.existsSync(options.output);
  } catch {
    return false;
  }
}
