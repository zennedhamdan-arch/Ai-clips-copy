"use client";

import { useState } from "react";
import type { ApiClip } from "@/lib/types";

export type ClipMusicAsset = { id: string; name: string; fileName: string };
export type ClipMusicTrack = { id: string; displayName: string; durationSec: number | null };

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scoreColour(score: number | null): string {
  if (score === null) return "bg-slate-700 text-slate-300";
  if (score >= 80) return "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40";
  if (score >= 60) return "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40";
  return "bg-slate-600/30 text-slate-300 ring-1 ring-slate-500/40";
}

export function ClipCard({ clip, musicAssets = [], musicTracks = [], onChanged }: {
  clip: ApiClip;
  musicAssets?: ClipMusicAsset[];
  musicTracks?: ClipMusicTrack[];
  onChanged?: () => void | Promise<void>;
}) {
  const initialChoice = clip.musicTrackId
    ? `b2:${clip.musicTrackId}`
    : clip.musicAssetId
      ? `r2:${clip.musicAssetId}`
      : musicTracks[0]
        ? `b2:${musicTracks[0].id}`
        : musicAssets[0]
          ? `r2:${musicAssets[0].id}`
          : "auto";
  const [musicChoice, setMusicChoice] = useState(initialChoice);
  const [volume, setVolume] = useState(Math.round((clip.musicVolume ?? 0.12) * 100));
  const [busy, setBusy] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [musicNote, setMusicNote] = useState<string | null>(null);
  const hasMusicLibrary = musicAssets.length > 0 || musicTracks.length > 0;

  async function changeMusic(method: "POST" | "DELETE") {
    setBusy(true);
    setMusicError(null);
    setMusicNote(null);
    const progressTimer = window.setInterval(() => void onChanged?.(), 1500);
    try {
      const body = method === "POST"
        ? JSON.stringify({
            volume: volume / 100,
            ...(musicChoice === "auto"
              ? { auto: true }
              : musicChoice.startsWith("b2:")
                ? { trackId: musicChoice.slice(3) }
                : { assetId: musicChoice.slice(3) }),
          })
        : undefined;
      const response = await fetch(`/api/clips/${clip.id}/music`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      const data = await response.json() as {
        error?: string;
        music?: { displayName?: string; selection?: { source?: string; reason?: string } | null; note?: string | null };
      };
      if (!response.ok) throw new Error(data.error || `Music request failed (${response.status})`);
      const selection = data.music?.selection;
      setMusicNote(
        selection
          ? `${selection.source === "ai" ? "✨ AI picked" : "Matched"}: ${data.music?.displayName ?? ""} — ${selection.reason}`
          : data.music?.note ?? null,
      );
      await onChanged?.();
    } catch (error) {
      setMusicError((error as Error).message);
      await onChanged?.();
    } finally {
      window.clearInterval(progressTimer);
      setBusy(false);
    }
  }

  if (clip.status === "failed") {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-red-300">
          <span>Clip {clip.clipIndex + 1} failed</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-red-200/80">{clip.error || "Unknown FFmpeg error"}</p>
        <p className="mt-2 text-[11px] text-slate-400">
          {formatDuration(clip.startSec)} → {formatDuration(clip.endSec)}
        </p>
      </div>
    );
  }

  if (clip.status !== "ready") {
    return (
      <div className="shimmer flex h-40 items-center justify-center rounded-2xl border border-white/10 text-xs text-slate-300">
        <span>{clip.status === "rendering" ? "Rendering…" : "Queued…"}</span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="relative bg-black">
        <video
          className="max-h-[62vh] w-full bg-black object-contain"
          style={{ aspectRatio: clip.width && clip.height ? `${clip.width} / ${clip.height}` : "9 / 16" }}
          src={clip.playbackUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
        />
        {clip.score !== null ? (
          <span
            className={`absolute left-2 top-2 rounded-full px-2 py-1 text-[11px] font-bold ${scoreColour(clip.score)}`}
          >
            {clip.score}/100
          </span>
        ) : null}
      </div>

      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold leading-snug text-white">{clip.title}</h3>
          {clip.hook ? (
            <p className="mt-1 text-xs font-medium text-indigo-300">Hook: {clip.hook}</p>
          ) : null}
        </div>

        {clip.reason ? (
          <p className="text-xs leading-relaxed text-slate-400">{clip.reason}</p>
        ) : null}

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>{formatDuration(clip.startSec)} → {formatDuration(clip.endSec)}</span>
          <span>{formatDuration(clip.durationSec)} long</span>
          <span>{formatBytes(clip.fileSizeBytes)}</span>
          {clip.width && clip.height ? (
            <span>
              {clip.width}×{clip.height}
            </span>
          ) : null}
        </div>

        {hasMusicLibrary ? (
          <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">Add background music</span>
              <span className={`text-[10px] uppercase tracking-wide ${clip.musicStatus === "failed" ? "text-red-300" : clip.musicEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                {busy ? (clip.musicStatus === "uploading" ? "Uploading" : "Mixing") : clip.musicStatus === "complete" ? "Complete" : clip.musicStatus}
              </span>
            </div>
            <select value={musicChoice} onChange={(event) => setMusicChoice(event.target.value)} disabled={busy} className="w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-xs text-white">
              <option value="auto">✨ Auto-pick (AI, metadata only)</option>
              {musicTracks.length ? (
                <optgroup label="Music Library (B2)">
                  {musicTracks.map((track) => (
                    <option key={track.id} value={`b2:${track.id}`}>🎵 {track.displayName}</option>
                  ))}
                </optgroup>
              ) : null}
              {musicAssets.length ? (
                <optgroup label="Media Library (R2)">
                  {musicAssets.map((asset) => (
                    <option key={asset.id} value={`r2:${asset.id}`}>{asset.name} ({asset.fileName})</option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            <label className="flex items-center gap-2 text-[11px] text-slate-400">
              Volume
              <input className="min-w-0 flex-1 accent-indigo-500" type="range" min="5" max="30" value={volume} disabled={busy} onChange={(event) => setVolume(Number(event.target.value))} />
              <span className="w-8 text-right">{volume}%</span>
            </label>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void changeMusic("POST")} className="flex-1 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? "Processing…" : clip.musicEnabled ? "Change music" : "Add background music"}
              </button>
              {clip.musicEnabled ? <button type="button" disabled={busy} onClick={() => void changeMusic("DELETE")} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200 disabled:opacity-50">Remove</button> : null}
            </div>
            {(musicError || clip.musicError) ? <p className="text-[11px] text-red-300">{musicError || clip.musicError}</p> : null}
            {musicNote ? <p className="text-[10px] leading-relaxed text-indigo-300">{musicNote}</p> : null}
            <p className="text-[10px] leading-relaxed text-slate-500">Uses the retained rendered clip only. It does not rerun transcription, AI analysis, clip selection, or source processing.</p>
          </div>
        ) : null}

        <a
          href={clip.downloadUrl ?? "#"}
          download
          className="block w-full rounded-xl bg-indigo-500 px-4 py-3 text-center text-sm font-semibold text-white active:scale-[0.99] active:bg-indigo-400"
        >
          Download clip
        </a>
      </div>
    </div>
  );
}
