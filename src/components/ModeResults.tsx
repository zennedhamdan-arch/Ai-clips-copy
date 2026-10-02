"use client";

import type { ApiJob } from "@/lib/types";

const HEADING_LABELS: Record<string, string> = {
  hook: "Hook",
  setup: "Setup",
  what_happened: "What Happened",
  why_it_matters: "Why It Matters",
  payoff: "Payoff",
  chapter: "Chapter",
};

function statusDot(status: string) {
  if (status === "ready") return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400" />;
  if (status === "failed") return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-400" />;
  return <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />;
}

function formatRange(start: number | null, end: number | null): string {
  if (start === null || end === null) return "no footage picked";
  const fmt = (value: number) => `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}`;
  return `${fmt(start)}–${fmt(end)}`;
}

/**
 * Progress detail for the two new modes:
 *   - Movie Explainer: the five story sections with narration + scene ranges
 *   - Documentary: the scene plan with asset + narration status per scene
 */
export function ModeResults({ job }: { job: ApiJob }) {
  if (job.mode === "movie_explainer" && job.script) {
    return (
      <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div>
          <h2 className="text-sm font-semibold text-white">{job.script.title}</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">{job.script.logline}</p>
        </div>
        <div className="space-y-1.5">
          {job.script.sections.map((section) => (
            <div key={section.heading} className="rounded-xl bg-black/20 px-3 py-2">
              <div className="flex items-center gap-2">
                {statusDot(section.audioStatus)}
                <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-300">
                  {HEADING_LABELS[section.heading] ?? section.heading}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-300">{section.title}</span>
                <span className="shrink-0 text-[9px] text-slate-500">{formatRange(section.sceneStartSec, section.sceneEndSec)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{section.narration}</p>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (job.mode === "documentary" && job.scenes?.length) {
    const assetsReady = job.scenes.filter((scene) => scene.assetStatus === "ready").length;
    const audioReady = job.scenes.filter((scene) => scene.audioStatus === "ready").length;
    return (
      <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">Scene plan</h2>
          <span className="text-[10px] text-slate-500">
            visuals {assetsReady}/{job.scenes.length} · narration {audioReady}/{job.scenes.length}
          </span>
        </div>
        <div className="space-y-1.5">
          {job.scenes.map((scene) => (
            <div key={scene.index} className="rounded-xl bg-black/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[9px] font-bold text-slate-500">{scene.index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-300">{scene.heading}</span>
                <span className="shrink-0 text-[9px] text-slate-500">~{scene.targetSec}s</span>
                {statusDot(scene.assetStatus)}
                {statusDot(scene.audioStatus)}
              </div>
              <p className="mt-1 line-clamp-1 text-[10px] text-slate-500">🎞 {scene.visualPrompt}</p>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return null;
}

export const JOB_MODE_BADGES: Record<string, string> = {
  clips: "✂️",
  movie_explainer: "🎬",
  documentary: "📽️",
};
