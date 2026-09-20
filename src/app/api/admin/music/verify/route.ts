import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { AppError, toErrorPayload } from "@/lib/errors";
import {
  checkB2,
  b2Configured,
  deleteB2Object,
  downloadB2ObjectToFile,
  headB2Object,
  listB2ObjectsPage,
  MUSIC_KEY_PREFIX,
  musicObjectKey,
  uploadFileToB2,
} from "@/lib/b2";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Admin-only Backblaze B2 round-trip check for the Music Library.
 * Uploads a tiny throwaway object, verifies it, downloads it, lists the music
 * prefix, deletes it and confirms it is gone. No credentials are returned.
 */
async function runVerification() {
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
  const probeId = `verify-${Date.now()}`;
  const key = musicObjectKey(probeId, "clipforge-verify.txt");
  const payload = `clipforge b2 music check ${new Date().toISOString()}`;
  const localPath = `/tmp/clipforge/b2-verify-${probeId}.txt`;
  const { mkdir, writeFile, readFile, rm } = await import("node:fs/promises");

  await mkdir("/tmp/clipforge", { recursive: true });
  await writeFile(localPath, payload, "utf8");

  try {
    const bucket = await checkB2();
    steps.push({ step: "headBucket", ok: true, detail: `${bucket.bucket} @ ${bucket.region}` });
  } catch (error) {
    steps.push({ step: "headBucket", ok: false, detail: (error as Error).message });
    return { ok: false, steps };
  }

  try {
    await uploadFileToB2(localPath, key, "text/plain");
    steps.push({ step: "upload", ok: true, detail: key });
  } catch (error) {
    steps.push({ step: "upload", ok: false, detail: (error as Error).message });
    return { ok: false, steps };
  }

  try {
    const head = await headB2Object(key);
    steps.push({ step: "head", ok: head.exists && head.sizeBytes === Buffer.byteLength(payload), detail: `size=${head.sizeBytes}` });
  } catch (error) {
    steps.push({ step: "head", ok: false, detail: (error as Error).message });
  }

  try {
    const downloadPath = `/tmp/clipforge/b2-verify-${probeId}-downloaded.txt`;
    await downloadB2ObjectToFile(key, downloadPath);
    const text = await readFile(downloadPath, "utf8");
    steps.push({ step: "download", ok: text === payload, detail: `${text.length} bytes` });
    await rm(downloadPath, { force: true });
  } catch (error) {
    steps.push({ step: "download", ok: false, detail: (error as Error).message });
  }

  try {
    const page = await listB2ObjectsPage({ prefix: MUSIC_KEY_PREFIX, maxKeys: 10 });
    steps.push({ step: "list", ok: true, detail: `${page.objects.length} object(s) under ${MUSIC_KEY_PREFIX}` });
  } catch (error) {
    steps.push({ step: "list", ok: false, detail: (error as Error).message });
  }

  try {
    await deleteB2Object(key, "b2-verify-cleanup");
    const head = await headB2Object(key);
    steps.push({ step: "delete", ok: !head.exists });
  } catch (error) {
    steps.push({ step: "delete", ok: false, detail: (error as Error).message });
  }

  await rm(localPath, { force: true }).catch(() => undefined);
  return { ok: steps.every((item) => item.ok), steps };
}

export async function GET(request: Request) {
  try {
    requireAdmin(request);
    if (!b2Configured()) {
      return NextResponse.json(
        {
          ok: false,
          configured: false,
          bucket: config.b2MusicBucket,
          message: "Backblaze B2 music storage is not configured on this service.",
        },
        { status: 503 },
      );
    }
    const result = await runVerification();
    return NextResponse.json({ ...result, configured: true, bucket: config.b2MusicBucket });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      { error: payload.message, detail: payload.detail },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
