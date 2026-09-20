import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { AppError, toErrorPayload } from "@/lib/errors";
import { getB2Object } from "@/lib/b2";
import { getMusicTrack } from "@/lib/music-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asWebStream(body: unknown): ReadableStream<Uint8Array> {
  const candidate = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (candidate.transformToWebStream) return candidate.transformToWebStream();
  return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Stream music from B2 for preview/playback. The browser only ever sees this
 * same-origin URL — no B2 endpoint, key or credential is exposed.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const track = await getMusicTrack(id);
    if (!track) throw new AppError("not_found", "Music track not found.", { status: 404 });
    const result = await getB2Object(track.b2ObjectKey, request.headers.get("range"));
    if (!result.Body) throw new AppError("not_found", "The stored music file is empty.", { status: 404 });
    const headers = new Headers({
      "Content-Type": result.ContentType || track.contentType || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${(track.fileName || path.basename(track.b2ObjectKey)).replace(/"/g, "")}"`,
    });
    if (result.ContentLength !== undefined) headers.set("Content-Length", String(result.ContentLength));
    if (result.ContentRange) headers.set("Content-Range", result.ContentRange);
    return new NextResponse(asWebStream(result.Body), { status: result.ContentRange ? 206 : 200, headers });
  } catch (error) {
    const payload = toErrorPayload(error);
    const upstreamStatus = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return NextResponse.json(
      { error: payload.message },
      { status: upstreamStatus === 416 ? 416 : error instanceof AppError ? error.status : 500 },
    );
  }
}
