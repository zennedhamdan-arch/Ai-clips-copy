import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { ensureRuntime } from "@/lib/jobs";
import { syncMusicLibraryFromB2 } from "@/lib/music-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Index B2 objects that are missing from the Music Library table.
 * Read-only against B2 (List + Head): no downloads, no re-uploads, no
 * deletes; already-indexed tracks (by unique b2_object_key) are skipped.
 */
export async function POST() {
  try {
    await ensureRuntime();
    const result = await syncMusicLibraryFromB2();
    return NextResponse.json({ ...result, at: new Date().toISOString() });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, kind: payload.kind, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
