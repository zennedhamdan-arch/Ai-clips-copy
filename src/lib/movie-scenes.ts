import { config } from "./config";
import { estimateNarrationDurationSec } from "./audio/router";
import type { ExplainerScript, ExplainerSection, ScriptHeading, StoryEvent } from "./types";

/**
 * Deterministic scene selection for the Movie Explainer.
 *
 * The AI script MAY suggest sceneStartSec/sceneEndSec; when it did (or when
 * the story analysis found events), this module clamps those ranges to the
 * source, guarantees each segment is long enough for its narration, and keeps
 * the story moving forward through the timeline. No AI call happens here —
 * retries are therefore always safe and idempotent.
 */

const HEADING_ORDER: ScriptHeading[] = ["hook", "setup", "what_happened", "why_it_matters", "payoff"];

const MIN_SCENE_SEC = 8;
const MAX_SCENE_SEC = 75;

function pickEventForHeading(heading: ScriptHeading, events: StoryEvent[], durationSec: number): StoryEvent | null {
  if (!events.length || !durationSec) return null;
  const sorted = [...events].sort((a, b) => a.startSec - b.startSec);
  const byImportance = (list: StoryEvent[]): StoryEvent | null =>
    list.length ? list.reduce((best, event) => (event.importance > best.importance ? event : best)) : null;

  const firstHalf = sorted.filter((event) => event.startSec < durationSec * 0.55);
  const middle = sorted.filter((event) => event.startSec >= durationSec * 0.2 && event.startSec <= durationSec * 0.75);
  switch (heading) {
    case "hook":
      return byImportance(firstHalf.length ? firstHalf : sorted);
    case "setup":
      return byImportance(sorted.filter((event) => event.characters.length >= 2)) ?? sorted[0];
    case "what_happened":
      return byImportance(middle.length ? middle : sorted);
    case "why_it_matters": {
      const causal = sorted.filter((event) => event.cause || event.effect);
      return byImportance(causal.length ? causal : middle.length ? middle : sorted);
    }
    case "payoff":
      return byImportance(sorted.filter((event) => event.startSec >= durationSec * 0.6));
    default:
      return null;
  }
}

function uniformRange(heading: ScriptHeading, durationSec: number): [number, number] {
  const position = HEADING_ORDER.indexOf(heading);
  const fraction = (position + 0.5) / HEADING_ORDER.length;
  const width = Math.min(MAX_SCENE_SEC, durationSec / HEADING_ORDER.length);
  const start = Math.max(0, Math.min(durationSec - width, fraction * durationSec));
  return [start, Math.min(durationSec, start + width)];
}

export function chooseSceneRange(
  heading: ScriptHeading,
  suggestedStart: number | null,
  suggestedEnd: number | null,
  events: StoryEvent[],
  durationSec: number,
): [number, number] {
  let start: number;
  let end: number;
  if (Number.isFinite(suggestedStart) && Number.isFinite(suggestedEnd) && (suggestedEnd ?? 0) > (suggestedStart ?? 0)) {
    start = suggestedStart as number;
    end = suggestedEnd as number;
  } else {
    const event = pickEventForHeading(heading, events, durationSec);
    if (event) {
      start = Math.max(0, event.startSec - 1.5);
      end = Math.min(durationSec, event.endSec + 2.5);
    } else {
      [start, end] = uniformRange(heading, durationSec);
    }
  }
  // Clamp into the source.
  start = Math.max(0, Math.min(start, Math.max(0, durationSec - 3)));
  end = Math.max(start + MIN_SCENE_SEC, Math.min(end, durationSec));
  if (end - start > MAX_SCENE_SEC) end = Math.min(durationSec, start + MAX_SCENE_SEC);
  if (end - start < MIN_SCENE_SEC) {
    end = Math.min(durationSec, start + MIN_SCENE_SEC);
    start = Math.max(0, end - MIN_SCENE_SEC);
  }
  return [Number(start.toFixed(2)), Number(end.toFixed(2))];
}

export function applySceneSelection(script: ExplainerScript, events: StoryEvent[], durationSec: number): ExplainerScript {
  const sections = script.sections.map((section): ExplainerSection => {
    const narrationSec = section.narrationSec && section.narrationSec > 0
      ? section.narrationSec
      : estimateNarrationDurationSec(section.narration);
    let [start, end] = chooseSceneRange(section.heading, section.sceneStartSec, section.sceneEndSec, events, durationSec);
    // Grow the range so the footage can carry the whole narration line.
    const needed = Math.min(MAX_SCENE_SEC, narrationSec + 1.2);
    if (end - start < needed) {
      end = Math.min(durationSec, start + needed);
      if (end - start < needed && start > 0) start = Math.max(0, end - needed);
    }
    return {
      ...section,
      sceneStartSec: Number(start.toFixed(2)),
      sceneEndSec: Number(end.toFixed(2)),
      sceneTitle: section.sceneTitle || section.title,
      targetSec: section.targetSec || Math.round(narrationSec),
    };
  });
  // Keep the story moving forward (each section starts at/after the previous
  // one's start) — a monotonic timeline reads as a story, not a shuffle.
  let cursor = 0;
  for (const section of sections) {
    if ((section.sceneStartSec ?? 0) < cursor) {
      const width = (section.sceneEndSec ?? cursor + MIN_SCENE_SEC) - cursor;
      section.sceneStartSec = Number(cursor.toFixed(2));
      section.sceneEndSec = Number(Math.min(durationSec, cursor + Math.max(MIN_SCENE_SEC, width)).toFixed(2));
    }
    cursor = Math.max(cursor, section.sceneStartSec ?? 0);
  }
  return { ...script, sections, updatedAt: new Date().toISOString() };
}

/** Word timestamps for burned-in narration captions (even pacing). */
export function narrationWordTiming(narration: string, durationSec: number): Array<{ word: string; start: number; end: number }> {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  if (!words.length || !(durationSec > 0)) return [];
  const perWord = durationSec / words.length;
  return words.map((word, index) => ({
    word,
    start: Number((index * perWord + 0.25).toFixed(3)),
    end: Number(((index + 1) * perWord + 0.25).toFixed(3)),
  }));
}

export function targetSecForMode(mode: "movie_explainer" | "documentary", requested: number | null | undefined): number {
  const fallback = mode === "movie_explainer" ? config.movieTargetSec : config.docTargetSec;
  const value = Math.round(requested ?? fallback);
  return Math.max(30, Math.min(300, value));
}
