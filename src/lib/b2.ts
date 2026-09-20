import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "./config";
import { AppError } from "./errors";

/**
 * Backblaze B2 client for the permanent Music Library.
 *
 * This module is the ONLY place that talks to B2. It mirrors the existing
 * Cloudflare R2 client in `object-storage.ts` (same AWS SDK pattern, same
 * streaming discipline) but is deliberately separate so that:
 *   - R2 keeps owning videos, sources, clips, posters and jobs
 *   - B2 owns only `music/{musicId}/{filename}`
 *   - a B2 outage can never break the normal ClipForge video pipeline
 * All credentials stay server-side; nothing from this module is ever
 * serialized to the browser.
 */

/** Root prefix for every Music Library object in B2. */
export const MUSIC_KEY_PREFIX = "music/";

let client: S3Client | null = null;

/** B2 requires the bucket region; fall back to the endpoint host if unset. */
export function b2Region(): string {
  if (config.b2Region) return config.b2Region;
  const match = config.b2Endpoint.match(/^https?:\/\/s3\.([^.]+)\./i);
  return match?.[1] ?? "";
}

export function b2Configured(): boolean {
  return Boolean(
    config.b2Endpoint &&
      b2Region() &&
      config.b2KeyId &&
      config.b2ApplicationKey &&
      config.b2MusicBucket,
  );
}

function b2(): S3Client {
  if (!b2Configured()) {
    throw new AppError("internal", "Backblaze B2 music storage is not configured.", {
      detail:
        "Set B2_ENDPOINT, B2_REGION, B2_KEY_ID, B2_APPLICATION_KEY and B2_MUSIC_BUCKET to enable the Music Library.",
      status: 503,
    });
  }
  // Created lazily so a missing secret cannot break the build or unrelated routes.
  client ??= new S3Client({
    region: b2Region(),
    endpoint: config.b2Endpoint,
    // B2 serves buckets on the regional endpoint path rather than virtual-host style.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.b2KeyId,
      secretAccessKey: config.b2ApplicationKey,
    },
    // B2 rejects the SDK's default integrity headers; only send them when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

/** `music/{musicId}/{filename}` — the only shape the Music Library writes. */
export function musicObjectKey(musicId: string, fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const base = path
    .basename(fileName, extension)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim()
    .slice(0, 100) || "track";
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".mp3";
  return `${MUSIC_KEY_PREFIX}${musicId}/${base}${safeExtension}`;
}

/** Guard used so R2 cleanup can never touch a B2 music object. */
export function isB2MusicKey(key: string | null | undefined): boolean {
  return Boolean(key && key.startsWith(MUSIC_KEY_PREFIX));
}

function isMissingObjectError(error: unknown): boolean {
  const typed = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    typed.$metadata?.httpStatusCode === 404 ||
    typed.name === "NotFound" ||
    typed.name === "NoSuchKey" ||
    typed.Code === "NoSuchKey"
  );
}

async function uploadBodyToB2(
  key: string,
  body: Readable,
  contentType: string,
): Promise<void> {
  try {
    const upload = new Upload({
      client: b2(),
      params: {
        Bucket: config.b2MusicBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      // One in-flight part keeps memory flat on a small instance.
      queueSize: 1,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("internal", "Could not upload music to Backblaze B2.", {
      detail: (error as Error).message,
      status: 502,
    });
  }
}

/** Stream a browser upload straight to B2; the file is never buffered in full. */
export async function uploadRequestToB2(options: {
  body: ReadableStream<Uint8Array> | null;
  key: string;
  maxBytes: number;
  contentType?: string | null;
}): Promise<number> {
  if (!options.body) throw new AppError("bad_request", "Upload body was empty.");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        callback(
          new AppError(
            "too_large",
            `Music file is larger than the ${Math.round(options.maxBytes / 1024 / 1024)}MB limit.`,
            { status: 413 },
          ),
        );
      } else callback(null, chunk);
    },
  });
  const input = Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0]);
  input.pipe(limiter);
  try {
    await uploadBodyToB2(options.key, limiter, options.contentType || "application/octet-stream");
    if (!bytes) throw new AppError("bad_request", "Uploaded music file was empty.");
    return bytes;
  } catch (error) {
    input.destroy();
    limiter.destroy();
    await deleteB2Object(options.key, "incomplete-music-upload-rollback").catch(() => undefined);
    throw error;
  }
}

export async function uploadFileToB2(
  filePath: string,
  key: string,
  contentType = "application/octet-stream",
): Promise<void> {
  await uploadBodyToB2(key, createReadStream(filePath), contentType);
}

export async function downloadB2ObjectToFile(key: string, target: string): Promise<void> {
  try {
    const result = await b2().send(
      new GetObjectCommand({ Bucket: config.b2MusicBucket, Key: key }),
    );
    if (!result.Body) throw new Error("B2 returned an empty response body");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await pipeline(result.Body as Readable, createWriteStream(target));
  } catch (error) {
    await fsp.rm(target, { force: true });
    if (isMissingObjectError(error)) {
      throw new AppError("source_object_missing", "The music file no longer exists in Backblaze B2.", {
        detail: `key=${key}`,
        status: 410,
      });
    }
    throw new AppError("download_failed", "Could not download the music file from Backblaze B2.", {
      detail: `key=${key}; ${(error as Error).message}`,
      status: 502,
    });
  }
}

/** Stream object for playback/preview. Credentials never leave the server. */
export async function getB2Object(key: string, range?: string | null) {
  return b2().send(
    new GetObjectCommand({
      Bucket: config.b2MusicBucket,
      Key: key,
      Range: range || undefined,
    }),
  );
}

export type B2ObjectMetadata = {
  exists: boolean;
  key: string;
  sizeBytes: number | null;
  contentType: string | null;
  lastModified: Date | null;
  etag: string | null;
};

export async function headB2Object(key: string): Promise<B2ObjectMetadata> {
  try {
    const result = await b2().send(
      new HeadObjectCommand({ Bucket: config.b2MusicBucket, Key: key }),
    );
    return {
      exists: true,
      key,
      sizeBytes: typeof result.ContentLength === "number" ? result.ContentLength : null,
      contentType: result.ContentType ?? null,
      lastModified: result.LastModified ?? null,
      etag: result.ETag ?? null,
    };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return { exists: false, key, sizeBytes: null, contentType: null, lastModified: null, etag: null };
    }
    throw error;
  }
}

export type B2ListedObject = {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
  etag: string | null;
};

export async function listB2ObjectsPage(options: {
  prefix?: string;
  continuationToken?: string | null;
  maxKeys?: number;
}): Promise<{ objects: B2ListedObject[]; nextToken: string | null; truncated: boolean }> {
  const result = await b2().send(
    new ListObjectsV2Command({
      Bucket: config.b2MusicBucket,
      Prefix: options.prefix || undefined,
      ContinuationToken: options.continuationToken ?? undefined,
      MaxKeys: Math.max(1, Math.min(1000, options.maxKeys ?? 100)),
    }),
  );
  return {
    objects: (result.Contents ?? [])
      .filter((item): item is typeof item & { Key: string } => Boolean(item.Key))
      .map((item) => ({
        key: item.Key,
        sizeBytes: item.Size ?? 0,
        lastModified: item.LastModified ?? null,
        etag: item.ETag ?? null,
      })),
    nextToken: result.IsTruncated ? result.NextContinuationToken ?? null : null,
    truncated: Boolean(result.IsTruncated),
  };
}

export async function deleteB2Object(key: string, reason = "unspecified"): Promise<void> {
  try {
    await b2().send(new DeleteObjectCommand({ Bucket: config.b2MusicBucket, Key: key }));
    console.info(`[B2 music] bucket=${config.b2MusicBucket} key=${key} action=deleted reason=${reason}`);
  } catch (error) {
    if (isMissingObjectError(error)) {
      console.info(`[B2 music] bucket=${config.b2MusicBucket} key=${key} action=already-missing reason=${reason}`);
      return;
    }
    console.error(
      `[B2 music] bucket=${config.b2MusicBucket} key=${key} action=delete-failed reason=${reason} error=${(error as Error).message}`,
    );
    throw error;
  }
}

export async function checkB2(): Promise<{ bucket: string; region: string; endpoint: string }> {
  await b2().send(new HeadBucketCommand({ Bucket: config.b2MusicBucket }));
  return { bucket: config.b2MusicBucket, region: b2Region(), endpoint: config.b2Endpoint };
}
