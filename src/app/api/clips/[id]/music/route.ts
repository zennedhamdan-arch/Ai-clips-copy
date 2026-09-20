import { NextResponse } from "next/server";
import { applyClipMusic, removeClipMusic } from "@/lib/clip-music";
import { AppError, toErrorPayload } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * Add/replace background music on an ALREADY RENDERED clip.
 * Body: { trackId?: string, assetId?: string, auto?: boolean, volume?: number }
 *  - trackId → B2 Music Library track
 *  - assetId → legacy Cloudflare R2 Media Library asset
 *  - auto    → AI metadata selection with deterministic fallback
 * Nothing here reruns transcription, analysis, selection or source processing.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      assetId?: string | null;
      trackId?: string | null;
      auto?: boolean;
      volume?: number;
    };
    const volume = Number.isFinite(Number(body.volume)) ? Number(body.volume) : 0.12;
    return NextResponse.json(
      await applyClipMusic(id, {
        assetId: body.assetId ?? null,
        trackId: body.trackId ?? null,
        auto: Boolean(body.auto),
        volume,
      }),
    );
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, kind: payload.kind, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await removeClipMusic(id));
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json({ error: payload.message, kind: payload.kind, detail: payload.detail }, { status: error instanceof AppError ? error.status : 500 });
  }
}
