import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { ensureRuntime } from "@/lib/jobs";
import { deleteB2Object } from "@/lib/b2";
import {
  deleteMusicTrack,
  getMusicTrack,
  musicTrackApi,
  musicTrackInUse,
  normalizeEnergy,
  normalizeGenre,
  normalizeMood,
  normalizeMusicTags,
  normalizeOptionalText,
  updateMusicTrack,
} from "@/lib/music-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const track = await getMusicTrack(id);
    if (!track) throw new AppError("not_found", "Music track not found.", { status: 404 });
    return NextResponse.json({ track: musicTrackApi(track) });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}

/** Edit metadata only — the stored audio in B2 is never rewritten. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const existing = await getMusicTrack(id);
    if (!existing) throw new AppError("not_found", "Music track not found.", { status: 404 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const displayName = normalizeOptionalText(body.displayName, 120);
    if (body.displayName !== undefined && !displayName) {
      throw new AppError("bad_request", "Display name cannot be empty.", { status: 400 });
    }
    if (body.energy !== undefined && body.energy !== null && normalizeEnergy(body.energy) === null) {
      throw new AppError("bad_request", "Energy must be low, medium, or high.", { status: 400 });
    }

    const updated = await updateMusicTrack(id, {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(body.mood !== undefined ? { mood: normalizeMood(body.mood) } : {}),
      ...(body.energy !== undefined ? { energy: normalizeEnergy(body.energy) } : {}),
      ...(body.genre !== undefined ? { genre: normalizeGenre(body.genre) } : {}),
      ...(body.tags !== undefined ? { tags: normalizeMusicTags(body.tags) } : {}),
    });
    if (!updated) throw new AppError("not_found", "Music track not found.", { status: 404 });
    return NextResponse.json({ track: musicTrackApi(updated) });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}

/**
 * Delete the database record first, then the B2 object. If the object delete
 * fails the row is already gone, so the response reports it and the orphan can
 * be removed from the admin storage page (which lists B2 directly).
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntime();
    const { id } = await context.params;
    const track = await getMusicTrack(id);
    if (!track) throw new AppError("not_found", "Music track not found.", { status: 404 });
    if (await musicTrackInUse(id)) {
      throw new AppError(
        "bad_request",
        "This track is being added to a clip right now. Try again in a moment.",
        { status: 409 },
      );
    }

    const deleted = await deleteMusicTrack(id);
    if (!deleted) throw new AppError("not_found", "Music track not found.", { status: 404 });

    let objectDeleted = true;
    let warning: string | null = null;
    try {
      await deleteB2Object(deleted.b2ObjectKey, "music-library-delete");
    } catch (error) {
      objectDeleted = false;
      warning = `The database record was deleted, but its B2 object could not be removed: ${(error as Error).message}`;
      console.error(`[music-library] delete object failed key=${deleted.b2ObjectKey}: ${(error as Error).message}`);
    }
    return NextResponse.json({ deleted: true, objectDeleted, warning });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
