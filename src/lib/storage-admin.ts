import { getDb } from "@/db";
import { clips, jobs, mediaAssets } from "@/db/schema";
import { MUSIC_KEY_PREFIX, b2Configured, listB2ObjectsPage, type B2ListedObject } from "./b2";
import { config } from "./config";
import { listObjectsPage, type R2ListedObject } from "./object-storage";

export type StorageReference = { type: "job" | "clip" | "media_asset"; id: string; field: string; label: string };

export async function loadStorageReferences(): Promise<Map<string, StorageReference[]>> {
  const [jobRows, clipRows, assetRows] = await Promise.all([
    getDb().select({ id: jobs.id, name: jobs.sourceName, source: jobs.sourceObjectKey, music: jobs.musicObjectKey }).from(jobs),
    getDb().select({ id: clips.id, title: clips.title, object: clips.objectKey, poster: clips.posterObjectKey, original: clips.originalObjectKey, music: clips.musicObjectKey }).from(clips),
    getDb().select({ id: mediaAssets.id, name: mediaAssets.name, object: mediaAssets.objectKey }).from(mediaAssets),
  ]);
  const refs = new Map<string, StorageReference[]>();
  const add = (key: string | null, reference: StorageReference) => {
    if (!key) return;
    refs.set(key, [...(refs.get(key) ?? []), reference]);
  };
  for (const row of jobRows) {
    add(row.source, { type: "job", id: row.id, field: "sourceObjectKey", label: row.name });
    add(row.music, { type: "job", id: row.id, field: "musicObjectKey", label: row.name });
  }
  for (const row of clipRows) {
    add(row.object, { type: "clip", id: row.id, field: "objectKey", label: row.title });
    add(row.poster, { type: "clip", id: row.id, field: "posterObjectKey", label: row.title });
    add(row.original, { type: "clip", id: row.id, field: "originalObjectKey", label: row.title });
    add(row.music, { type: "clip", id: row.id, field: "musicObjectKey", label: row.title });
  }
  for (const row of assetRows) add(row.object, { type: "media_asset", id: row.id, field: "objectKey", label: row.name });
  return refs;
}

export async function listAllObjects(): Promise<R2ListedObject[]> {
  const result: R2ListedObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await listObjectsPage({ continuationToken, maxKeys: 1000 });
    result.push(...page.objects);
    continuationToken = page.nextToken ?? undefined;
  } while (continuationToken);
  return result;
}

/* ------------------------------------------------------------------ */
/* Backblaze B2 Music Library storage (read-only, paginated)          */
/* ------------------------------------------------------------------ */

/** Safety valve so an admin page load can never walk an unbounded bucket. */
const MAX_MUSIC_WALK_PAGES = 200;

export type MusicStorageObject = {
  key: string;
  sizeBytes: number;
  lastModified: string | null;
  etag: string | null;
};

export type MusicStorageListing = {
  provider: "backblaze-b2";
  bucket: string;
  configured: boolean;
  error: string | null;
  objectCount: number;
  totalSizeBytes: number;
  page: number;
  pageSize: number;
  pages: number;
  /** True when the walk stopped early (counts are a lower bound). */
  truncated: boolean;
  objects: MusicStorageObject[];
};

/**
 * List the B2 Music Library one page at a time. Only the requested page is
 * kept in memory; every other page is counted and discarded, so a large music
 * bucket never blows up the instance.
 */
export async function listMusicStoragePage(options: {
  page?: number;
  pageSize?: number;
  query?: string | null;
}): Promise<MusicStorageListing> {
  const pageSize = Math.max(5, Math.min(200, Math.round(options.pageSize ?? 25)));
  const page = Math.max(1, Math.round(options.page ?? 1));
  const query = options.query?.trim().toLowerCase() ?? "";
  const empty = (error: string | null = null): MusicStorageListing => ({
    provider: "backblaze-b2",
    bucket: config.b2MusicBucket,
    configured: false,
    error,
    objectCount: 0,
    totalSizeBytes: 0,
    page,
    pageSize,
    pages: 1,
    truncated: false,
    objects: [],
  });

  if (!b2Configured()) {
    return empty("Backblaze B2 music storage is not configured (B2_ENDPOINT/B2_REGION/B2_KEY_ID/B2_APPLICATION_KEY/B2_MUSIC_BUCKET).");
  }

  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  let token: string | null = null;
  let objectCount = 0;
  let totalSizeBytes = 0;
  let pagesWalked = 0;
  let truncated = false;
  const target: B2ListedObject[] = [];

  try {
    do {
      const result = await listB2ObjectsPage({
        prefix: MUSIC_KEY_PREFIX,
        continuationToken: token,
        maxKeys: 1000,
      });
      pagesWalked += 1;
      for (const object of result.objects) {
        if (query && !object.key.toLowerCase().includes(query)) continue;
        objectCount += 1;
        totalSizeBytes += object.sizeBytes;
        // Only the requested slice is ever retained.
        if (objectCount > startIndex && objectCount <= endIndex) target.push(object);
      }
      token = result.nextToken;
      if (token && pagesWalked >= MAX_MUSIC_WALK_PAGES) {
        truncated = true;
        break;
      }
    } while (token);
  } catch (error) {
    return empty((error as Error).message);
  }

  return {
    provider: "backblaze-b2",
    bucket: config.b2MusicBucket,
    configured: true,
    error: null,
    objectCount,
    totalSizeBytes,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(objectCount / pageSize)),
    truncated,
    objects: target.map((object) => ({
      key: object.key,
      sizeBytes: object.sizeBytes,
      lastModified: object.lastModified ? object.lastModified.toISOString() : null,
      etag: object.etag,
    })),
  };
}
