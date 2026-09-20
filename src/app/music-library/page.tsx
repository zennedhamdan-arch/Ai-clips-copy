"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Track = {
  id: string;
  fileName: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  durationSec: number | null;
  mood: string | null;
  energy: string | null;
  genre: string | null;
  tags: string[];
  status: string;
  error: string | null;
  createdAt: string;
  playbackUrl: string;
};

type Stats = { trackCount: number; readyCount: number; totalSizeBytes: number };
type Storage = { provider: string; bucket: string; configured: boolean };
type Limits = { maxMusicUploadMb: number; maxFilesPerBatch: number; uploadConcurrency: number };

type UploadItem = { id: string; name: string; sizeBytes: number; status: "queued" | "uploading" | "saving" | "done" | "failed"; progress: number; error?: string };

const MOODS = ["Inspiring", "Energetic", "Calm", "Happy", "Emotional", "Tense", "Dark", "Playful", "Epic", "Corporate"];
const ENERGIES = ["low", "medium", "high"];
const GENRES = ["Cinematic", "Ambient", "Lo-fi", "Corporate", "Electronic", "Acoustic", "Hip-hop", "Rock", "Pop", "Jazz", "Classical", "Podcast"];

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Run tasks with bounded concurrency so bulk uploads stay gentle on the server. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

export default function MusicLibraryPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState("");
  const [energy, setEnergy] = useState("");
  const [genre, setGenre] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadMood, setUploadMood] = useState("");
  const [uploadEnergy, setUploadEnergy] = useState("");
  const [uploadGenre, setUploadGenre] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ displayName: string; mood: string; energy: string; genre: string; tags: string }>({
    displayName: "", mood: "", energy: "", genre: "", tags: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "24" });
      if (query.trim()) params.set("q", query.trim());
      if (mood) params.set("mood", mood);
      if (energy) params.set("energy", energy);
      if (genre) params.set("genre", genre);
      const response = await fetch(`/api/music/library?${params}`, { cache: "no-store" });
      const data = (await response.json()) as {
        tracks?: Track[]; pages?: number; total?: number; stats?: Stats; storage?: Storage; limits?: Limits; error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Could not load the Music Library.");
      setTracks(data.tracks ?? []);
      setPages(data.pages ?? 1);
      setTotal(data.total ?? 0);
      if (data.stats) setStats(data.stats);
      if (data.storage) setStorage(data.storage);
      if (data.limits) setLimits(data.limits);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, query, mood, energy, genre]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const uploadFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const maxFiles = limits?.maxFilesPerBatch ?? 25;
    const maxBytes = (limits?.maxMusicUploadMb ?? 50) * 1024 * 1024;
    const selected = Array.from(files).slice(0, maxFiles);
    const items: UploadItem[] = selected.map((file, index) => ({
      id: `${Date.now()}-${index}`,
      name: file.name,
      sizeBytes: file.size,
      status: file.size > maxBytes ? "failed" : "queued",
      progress: 0,
      error: file.size > maxBytes ? `Larger than ${limits?.maxMusicUploadMb ?? 50}MB` : undefined,
    }));
    setUploads(items);
    setUploading(true);
    setError(null);

    const patch = (id: string, changes: Partial<UploadItem>) =>
      setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));

    const uploadOne = (file: File, index: number) =>
      new Promise<void>((resolve) => {
        const item = items[index];
        if (item.status === "failed") return resolve();
        patch(item.id, { status: "uploading" });
        const params = new URLSearchParams();
        if (uploadMood) params.set("mood", uploadMood);
        if (uploadEnergy) params.set("energy", uploadEnergy);
        if (uploadGenre) params.set("genre", uploadGenre);
        if (uploadTags.trim()) params.set("tags", uploadTags.trim());
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/music/library?${params}`);
        xhr.timeout = 300_000;
        xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.upload.onprogress = (event) =>
          event.lengthComputable && patch(item.id, { progress: Math.round((event.loaded / event.total) * 100) });
        xhr.upload.onload = () => patch(item.id, { progress: 100, status: "saving" });
        xhr.onload = () => {
          let message: string | null = null;
          try {
            const result = JSON.parse(xhr.responseText) as { error?: string };
            if (xhr.status < 200 || xhr.status >= 300) message = result.error || `Upload failed (${xhr.status})`;
          } catch {
            message = `Upload failed (${xhr.status})`;
          }
          patch(item.id, message ? { status: "failed", error: message } : { status: "done" });
          resolve();
        };
        xhr.onerror = () => { patch(item.id, { status: "failed", error: "Network error" }); resolve(); };
        xhr.ontimeout = () => { patch(item.id, { status: "failed", error: "Timed out" }); resolve(); };
        xhr.send(file);
      });

    // Bounded concurrency: only a couple of files stream to B2 at a time.
    await mapWithConcurrency(selected, limits?.uploadConcurrency ?? 2, uploadOne);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
    await load();
  }, [limits, load, uploadEnergy, uploadGenre, uploadMood, uploadTags]);

  const startEdit = (track: Track) => {
    setEditing(track.id);
    setDraft({
      displayName: track.displayName,
      mood: track.mood ?? "",
      energy: track.energy ?? "",
      genre: track.genre ?? "",
      tags: track.tags.join(", "),
    });
  };

  const saveEdit = async (track: Track) => {
    try {
      const response = await fetch(`/api/music/library/${track.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: draft.displayName,
          mood: draft.mood || null,
          energy: draft.energy || null,
          genre: draft.genre || null,
          tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save metadata.");
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeTrack = async (track: Track) => {
    if (!window.confirm(`Delete “${track.displayName}” from the Music Library?`)) return;
    const response = await fetch(`/api/music/library/${track.id}`, { method: "DELETE" });
    const data = (await response.json()) as { error?: string; warning?: string };
    if (!response.ok) {
      setError(data.error || "Delete failed.");
      return;
    }
    if (data.warning) setError(data.warning);
    await load();
  };

  const filterTags = useMemo(
    () => [...new Set(tracks.flatMap((track) => track.tags))].slice(0, 20),
    [tracks],
  );

  return (
    <main className="space-y-5 pb-10">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-indigo-400">Permanent music · Backblaze B2</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Music Library</h1>
          {storage ? (
            <p className="mt-1 text-[11px] text-slate-500">
              Bucket <span className="font-mono text-slate-400">{storage.bucket}</span>
              {storage.configured ? "" : " · not configured"}
              {stats ? ` · ${stats.trackCount} track${stats.trackCount === 1 ? "" : "s"} · ${formatBytes(stats.totalSizeBytes)} total` : ""}
            </p>
          ) : null}
        </div>
        <Link href="/" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">← Clip creator</Link>
      </header>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-sm font-semibold text-white">Upload MP3s</h2>
        <p className="mt-1 text-[11px] text-slate-500">
          Select several files at once — they upload {limits?.uploadConcurrency ?? 2} at a time and stream straight to B2.
        </p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
          disabled={uploading}
          className="mt-3 block w-full cursor-pointer rounded-xl border border-dashed border-white/15 bg-black/20 p-3 text-[11px] text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-500 file:px-3 file:py-2 file:text-[11px] file:font-semibold file:text-white"
          onChange={(event) => void uploadFiles(event.target.files)}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <select value={uploadMood} onChange={(event) => setUploadMood(event.target.value)} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
            <option value="">Mood (optional)</option>
            {MOODS.map((item) => <option key={item}>{item}</option>)}
          </select>
          <select value={uploadEnergy} onChange={(event) => setUploadEnergy(event.target.value)} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
            <option value="">Energy (optional)</option>
            {ENERGIES.map((item) => <option key={item}>{item}</option>)}
          </select>
          <select value={uploadGenre} onChange={(event) => setUploadGenre(event.target.value)} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
            <option value="">Genre (optional)</option>
            {GENRES.map((item) => <option key={item}>{item}</option>)}
          </select>
          <input value={uploadTags} onChange={(event) => setUploadTags(event.target.value)} placeholder="Tags (comma separated)" className="rounded-lg border border-white/10 bg-black/20 px-2 py-2 text-[11px] text-white outline-none focus:border-indigo-400" />
        </div>
        {uploads.length ? (
          <ul className="mt-3 space-y-1.5">
            {uploads.map((item) => (
              <li key={item.id} className="rounded-lg bg-black/20 px-3 py-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-slate-300">{item.name}</span>
                  <span className={
                    item.status === "done" ? "text-emerald-300" :
                    item.status === "failed" ? "text-red-300" :
                    "text-slate-500"
                  }>
                    {item.status === "done" ? "Saved" : item.status === "failed" ? (item.error ?? "Failed") : item.status === "saving" ? "Probing metadata…" : `Uploading ${item.progress}%`}
                  </span>
                </div>
                {item.status === "uploading" ? (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-indigo-400 transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:grid-cols-4">
        <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search name, genre, mood…" className="rounded-lg border border-white/10 bg-black/20 px-2 py-2 text-[11px] text-white outline-none focus:border-indigo-400 sm:col-span-2" />
        <select value={mood} onChange={(event) => { setMood(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
          <option value="">All moods</option>
          {MOODS.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={energy} onChange={(event) => { setEnergy(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
          <option value="">All energies</option>
          {ENERGIES.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={genre} onChange={(event) => { setGenre(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300 sm:col-span-2">
          <option value="">All genres</option>
          {GENRES.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select
          value=""
          onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300 sm:col-span-2"
        >
          <option value="">Filter by tag…</option>
          {filterTags.map((tag) => <option key={tag}>{tag}</option>)}
        </select>
        <button type="button" onClick={() => { setQuery(""); setMood(""); setEnergy(""); setGenre(""); setPage(1); }} className="rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-300 sm:col-span-4">Clear filters</button>
      </section>

      {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div> : null}

      <section className="space-y-3">
        {loading && !tracks.length ? <p className="text-xs text-slate-500">Loading music…</p> : null}
        {!loading && !tracks.length ? (
          <div className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-xs text-slate-500">
            No music yet. Upload your first MP3 above.
          </div>
        ) : null}
        {tracks.map((track) => (
          <article key={track.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-white">{track.displayName}</h3>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">{track.fileName}</p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {formatBytes(track.sizeBytes)} · {formatDuration(track.durationSec)}
                  {track.mood ? ` · ${track.mood}` : ""}
                  {track.energy ? ` · ${track.energy} energy` : ""}
                  {track.genre ? ` · ${track.genre}` : ""}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${track.status === "ready" ? "bg-emerald-500/15 text-emerald-300" : track.status === "failed" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300"}`}>
                {track.status.toUpperCase()}
              </span>
            </div>

            {track.status === "ready" ? (
              <audio controls preload="metadata" src={track.playbackUrl} className="mt-2 h-8 w-full" />
            ) : null}
            {track.error ? <p className="mt-1 text-[10px] text-amber-300">{track.error}</p> : null}

            {track.tags.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {track.tags.map((tag) => <span key={tag} className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-slate-400">{tag}</span>)}
              </div>
            ) : null}

            {editing === track.id ? (
              <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
                <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white" placeholder="Display name" />
                <div className="grid grid-cols-3 gap-2">
                  <select value={draft.mood} onChange={(event) => setDraft({ ...draft, mood: event.target.value })} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
                    <option value="">Mood</option>
                    {MOODS.map((item) => <option key={item}>{item}</option>)}
                  </select>
                  <select value={draft.energy} onChange={(event) => setDraft({ ...draft, energy: event.target.value })} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
                    <option value="">Energy</option>
                    {ENERGIES.map((item) => <option key={item}>{item}</option>)}
                  </select>
                  <select value={draft.genre} onChange={(event) => setDraft({ ...draft, genre: event.target.value })} className="rounded-lg border border-white/10 bg-[#0d1220] px-2 py-2 text-[11px] text-slate-300">
                    <option value="">Genre</option>
                    {GENRES.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </div>
                <input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white" placeholder="Tags (comma separated)" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void saveEdit(track)} className="flex-1 rounded-lg bg-indigo-500 px-3 py-2 text-[11px] font-semibold text-white">Save metadata</button>
                  <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] text-slate-200">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => startEdit(track)} className="flex-1 rounded-lg border border-white/15 px-3 py-2 text-[11px] font-semibold text-slate-200">Edit metadata</button>
                <button type="button" onClick={() => void removeTrack(track)} className="rounded-lg border border-red-500/30 px-3 py-2 text-[11px] font-semibold text-red-300">Delete</button>
              </div>
            )}
          </article>
        ))}
      </section>

      <div className="flex items-center justify-center gap-3 text-xs">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/10 px-3 py-2 disabled:opacity-30">Previous</button>
        <span>Page {page} of {pages} · {total} tracks</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-white/10 px-3 py-2 disabled:opacity-30">Next</button>
      </div>
    </main>
  );
}
