import { requestStructuredJson } from "./analyze";
import { extractJson } from "./analyze";
import type { MusicSelectionCandidate } from "./music-library";

/**
 * Music selection for clips.
 *
 * The AI only ever sees track METADATA (name, mood, energy, genre, tags,
 * duration) plus the clip's own text — never an audio file, object key or
 * signed URL. If the AI call fails for any reason we fall back to
 * deterministic metadata matching, and if nothing matches we return null so
 * the caller renders the clip normally without music.
 */

export type ClipMusicContext = {
  clipId: string;
  title: string;
  hook: string | null;
  reason: string | null;
  score: number | null;
  durationSec: number | null;
  sourceName?: string | null;
};

export type MusicSelection = {
  trackId: string;
  displayName: string;
  reason: string;
  source: "ai" | "deterministic";
};

const MOOD_CUES: Record<string, string[]> = {
  inspiring: ["inspire", "motivat", "success", "growth", "win", "lesson", "hope", "believe", "dream", "advice", "learn"],
  energetic: ["energy", "fast", "hype", "rush", "launch", "boost", "grind", "workout", "excited"],
  calm: ["calm", "slow", "relax", "peace", "quiet", "gentle", "mindful", "sleep", "breath"],
  happy: ["happy", "fun", "joy", "smile", "laugh", "celebrat", "grateful", "good news"],
  emotional: ["emotion", "feel", "heart", "personal", "family", "tough", "real", "cry", "love"],
  tense: ["tense", "risk", "warn", "danger", "problem", "urgent", "mistake", "fail", "wrong"],
  dark: ["dark", "secret", "fear", "lost", "truth", "scary", "honest"],
  playful: ["funny", "joke", "silly", "play", "weird", "meme", "chaos", "crazy"],
  epic: ["epic", "massive", "legend", "journey", "reveal", "huge", "biggest"],
  corporate: ["business", "market", "company", "money", "data", "strategy", "team", "client", "profit"],
};

const GENRE_CUES: Record<string, string[]> = {
  cinematic: ["story", "journey", "reveal", "epic", "moment", "documentary"],
  ambient: ["calm", "focus", "slow", "background", "relax", "sleep"],
  corporate: ["business", "money", "market", "team", "strategy", "client", "work"],
  "lo-fi": ["study", "chill", "relax", "focus", "late night"],
  electronic: ["tech", "future", "ai", "digital", "fast", "launch", "software"],
  acoustic: ["personal", "honest", "story", "family", "home", "heart"],
  "hip-hop": ["street", "hustle", "grind", "city", "bold", "confidence"],
  rock: ["loud", "power", "rebel", "strong", "intense"],
  pop: ["fun", "bright", "catchy", "trend", "viral"],
};

const HIGH_ENERGY_CUES = ["fast", "hype", "excited", "energy", "rush", "launch", "grind", "amazing", "insane", "crazy", "big", "win"];
const LOW_ENERGY_CUES = ["calm", "slow", "quiet", "gentle", "sad", "soft", "serious", "honest", "truth", "lesson", "peace"];

export type ClipMusicProfile = {
  mood: string | null;
  energy: string | null;
  genre: string | null;
  haystack: string;
  hasContext: boolean;
};

function matchBest(cues: Record<string, string[]>, haystack: string): string | null {
  let best: { key: string; score: number } | null = null;
  for (const [key, words] of Object.entries(cues)) {
    const score = words.filter((word) => haystack.includes(word)).length;
    if (score && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

export function inferClipMusicProfile(context: ClipMusicContext): ClipMusicProfile {
  const haystack = `${context.title} ${context.hook ?? ""} ${context.reason ?? ""} ${context.sourceName ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const highEnergy = HIGH_ENERGY_CUES.filter((word) => haystack.includes(word)).length;
  const lowEnergy = LOW_ENERGY_CUES.filter((word) => haystack.includes(word)).length;
  let energy: string | null = highEnergy === lowEnergy ? null : highEnergy > lowEnergy ? "high" : "low";
  if (!energy && typeof context.score === "number") {
    if (context.score >= 80) energy = "high";
    else if (context.score <= 55) energy = "medium";
  }
  return {
    mood: matchBest(MOOD_CUES, haystack),
    energy,
    genre: matchBest(GENRE_CUES, haystack),
    haystack,
    hasContext: haystack.length > 0,
  };
}

/**
 * Deterministic metadata matching used whenever AI selection is unavailable,
 * disabled, or returns something unusable.
 */
export function deterministicMusicSelection(
  candidates: MusicSelectionCandidate[],
  context: ClipMusicContext,
): MusicSelection | null {
  if (!candidates.length) return null;
  const profile = inferClipMusicProfile(context);
  const ranked = candidates
    .map((candidate, index) => {
      // `score` is evidence of a real match; `preference` only breaks ties.
      let score = 0;
      let preference = 0;
      const reasons: string[] = [];
      const mood = candidate.mood?.toLowerCase() ?? "";
      const genre = candidate.genre?.toLowerCase() ?? "";
      const energy = candidate.energy?.toLowerCase() ?? "";

      if (profile.mood && mood === profile.mood) {
        score += 5;
        reasons.push(`mood:${candidate.mood}`);
      } else if (mood && profile.haystack.includes(mood)) {
        score += 3;
        reasons.push(`mood cue:${candidate.mood}`);
      }
      if (profile.genre && genre === profile.genre) {
        score += 4;
        reasons.push(`genre:${candidate.genre}`);
      } else if (genre && profile.haystack.includes(genre)) {
        score += 2;
        reasons.push(`genre cue:${candidate.genre}`);
      }
      if (profile.energy && energy === profile.energy) {
        score += 3;
        reasons.push(`energy:${candidate.energy}`);
      }
      for (const tag of candidate.tags) {
        const normalized = tag.toLowerCase();
        if (profile.haystack.includes(normalized)) {
          score += 2;
          reasons.push(`tag:${tag}`);
        } else if (profile.mood && MOOD_CUES[profile.mood]?.some((cue) => normalized.includes(cue))) {
          score += 1;
          reasons.push(`related:${tag}`);
        }
      }
      if (context.durationSec && candidate.durationSec && candidate.durationSec >= context.durationSec) {
        preference += 1;
        reasons.push("long enough to cover the clip");
      }
      // Stable tie-break: earlier tracks win so results never flicker.
      return { candidate, score, preference, index, reasons };
    })
    .sort((a, b) => b.score - a.score || b.preference - a.preference || a.index - b.index);

  const best = ranked[0];
  if (!best) return null;
  if (best.score <= 0) {
    // Nothing in the library fits the clip, and the clip has real context:
    // render it without music rather than forcing an unrelated track.
    if (profile.hasContext) return null;
    return {
      trackId: best.candidate.id,
      displayName: best.candidate.displayName,
      reason: "No clip context available; using the first available track.",
      source: "deterministic",
    };
  }
  return {
    trackId: best.candidate.id,
    displayName: best.candidate.displayName,
    reason: `Matched ${best.reasons.slice(0, 3).join(", ")}.`,
    source: "deterministic",
  };
}

const MUSIC_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["trackId", "reason"],
  properties: {
    trackId: { type: "string", description: "The exact id of the chosen track." },
    reason: { type: "string", description: "One short sentence explaining the choice." },
  },
} as Record<string, unknown>;

const MUSIC_SYSTEM_PROMPT = [
  "You are a music supervisor for short-form vertical clips.",
  "You only ever receive text metadata about tracks — never audio.",
  "Choose the single track whose mood, energy, genre and tags best support the clip's emotion and pacing.",
  "Prefer tracks long enough to cover the clip without heavy looping.",
  "Reply with JSON only: {\"trackId\": string, \"reason\": string}.",
].join(" ");

function candidateLines(candidates: MusicSelectionCandidate[]): string {
  return candidates
    .map(
      (candidate, index) =>
        `${index + 1}. id=${candidate.id} | name="${candidate.displayName}" | mood=${candidate.mood ?? "unknown"} | energy=${candidate.energy ?? "unknown"} | genre=${candidate.genre ?? "unknown"} | tags=${candidate.tags.join(", ") || "none"} | durationSec=${candidate.durationSec ?? "unknown"}`,
    )
    .join("\n");
}

/** AI selection over metadata only. Returns null if no candidate is usable. */
async function aiMusicSelection(
  candidates: MusicSelectionCandidate[],
  context: ClipMusicContext,
): Promise<MusicSelection | null> {
  if (!candidates.length) return null;
  const user = [
    "CLIP:",
    `title: ${context.title}`,
    `hook: ${context.hook ?? "n/a"}`,
    `why it matters: ${context.reason ?? "n/a"}`,
    `score: ${context.score ?? "n/a"}`,
    `durationSec: ${context.durationSec ?? "n/a"}`,
    context.sourceName ? `source: ${context.sourceName}` : "",
    "",
    "CANDIDATE TRACKS (metadata only):",
    candidateLines(candidates),
    "",
    "Return the id of the single best track.",
  ]
    .filter(Boolean)
    .join("\n");

  const { content } = await requestStructuredJson({
    system: MUSIC_SYSTEM_PROMPT,
    user,
    schema: MUSIC_SELECTION_SCHEMA,
    outputTokenLimit: 300,
  });
  const parsed = extractJson(content) as { trackId?: unknown; reason?: unknown } | null;
  const trackId = typeof parsed?.trackId === "string" ? parsed.trackId.trim() : "";
  if (!trackId) return null;
  const match = candidates.find((candidate) => candidate.id === trackId);
  if (!match) return null;
  return {
    trackId: match.id,
    displayName: match.displayName,
    reason: typeof parsed?.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 240)
      : "AI selected this track from its metadata.",
    source: "ai",
  };
}

const NO_MATCH_NOTE =
  "No track in the Music Library matches this clip's mood, energy, genre, or tags, so the clip was left without music.";

export type MusicSelectionResult = {
  selection: MusicSelection | null;
  /** Why the AI path was skipped or failed, for the UI/job log. */
  note: string | null;
};

/**
 * Choose background music for a clip.
 * AI first (metadata only) → deterministic metadata matching → null.
 * This function never throws: a music failure must never break video output.
 */
export async function selectMusicForClip(options: {
  candidates: MusicSelectionCandidate[];
  context: ClipMusicContext;
  allowAi?: boolean;
}): Promise<MusicSelectionResult> {
  const candidates = options.candidates.slice(0, 60);
  if (!candidates.length) {
    return { selection: null, note: "The Music Library has no ready tracks yet." };
  }
  if (options.allowAi !== false) {
    try {
      const selection = await aiMusicSelection(candidates, options.context);
      if (selection) return { selection, note: null };
      const fallback = deterministicMusicSelection(candidates, options.context);
      return {
        selection: fallback,
        note: fallback
          ? "AI music selection returned an unusable track; used deterministic metadata matching."
          : NO_MATCH_NOTE,
      };
    } catch (error) {
      console.warn(`[music-selection] AI selection failed; using deterministic matching: ${(error as Error).message}`);
      const fallback = deterministicMusicSelection(candidates, options.context);
      return {
        selection: fallback,
        note: fallback
          ? `AI music selection unavailable (${(error as Error).message.slice(0, 160)}); used deterministic metadata matching.`
          : `${NO_MATCH_NOTE} (AI selection was also unavailable: ${(error as Error).message.slice(0, 120)})`,
      };
    }
  }
  const selection = deterministicMusicSelection(candidates, options.context);
  return {
    selection,
    note: selection ? "AI selection skipped." : NO_MATCH_NOTE,
  };
}
