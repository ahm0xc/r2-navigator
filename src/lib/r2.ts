import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { resolvedEndpoint, type R2Credentials } from "./config.js";

export type R2EntryType = "bucket" | "folder" | "file";

export interface R2Entry {
  /** Display name (basename, e.g. "photos/" or "hero.png"). */
  name: string;
  /** Full key for files/folders, bucket name for buckets. */
  key: string;
  type: R2EntryType;
  size?: number;
  lastModified?: Date;
}

export function createR2Client(creds: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: resolvedEndpoint(creds),
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: false,
  });
}

export async function testConnection(client: S3Client): Promise<number> {
  const res = await client.send(new ListBucketsCommand({}));
  return res.Buckets?.length ?? 0;
}

export async function listBuckets(client: S3Client): Promise<R2Entry[]> {
  const res = await client.send(new ListBucketsCommand({}));
  const buckets = (res.Buckets ?? [])
    .map((b) => ({
      name: b.Name ?? "",
      key: b.Name ?? "",
      type: "bucket" as const,
    }))
    .filter((b) => b.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return buckets;
}

const PAGE_SIZE = 1000;
const MAX_ENTRIES = 5000;

function baseName(key: string, prefix: string): string {
  return key.slice(prefix.length);
}

/** List one browsable level. No bucket => buckets. Else folders + files under prefix. */
export async function listLevel(
  client: S3Client,
  bucket: string | null,
  prefix: string
): Promise<{ entries: R2Entry[]; truncated: boolean }> {
  if (!bucket) {
    const entries = await listBuckets(client);
    return { entries, truncated: false };
  }

  const folders = new Map<string, R2Entry>();
  const files: R2Entry[] = [];
  let continuation: string | undefined;
  let truncated = false;
  let total = 0;

  for (;;) {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        MaxKeys: PAGE_SIZE,
        ContinuationToken: continuation,
      })
    );

    for (const cp of res.CommonPrefixes ?? []) {
      const dirKey = cp.Prefix ?? "";
      if (!dirKey || folders.has(dirKey)) continue;
      folders.set(dirKey, {
        name: baseName(dirKey, prefix),
        key: dirKey,
        type: "folder",
      });
      total += 1;
    }

    for (const obj of res.Contents ?? []) {
      const key = obj.Key ?? "";
      // Skip the placeholder object for the current prefix itself.
      if (!key || key === prefix) continue;
      files.push({
        name: baseName(key, prefix),
        key,
        type: "file",
        size: obj.Size,
        lastModified: obj.LastModified,
      });
      total += 1;
      if (total >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
    }

    if (total >= MAX_ENTRIES) break;
    if (res.IsTruncated && res.NextContinuationToken) {
      continuation = res.NextContinuationToken;
      if (!res.Contents?.length && !(res.CommonPrefixes ?? []).length) break;
    } else {
      break;
    }
  }

  const folderList = [...folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { entries: [...folderList, ...files], truncated };
}

export async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array | Buffer,
  contentType?: string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body as unknown as Uint8Array,
      ...(contentType ? { ContentType: contentType } : {}),
    })
  );
}

export async function createFolder(
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<void> {
  const key = prefix.endsWith("/") ? prefix : `${prefix}/`;
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array() })
  );
}

export async function deleteKeys(
  client: S3Client,
  bucket: string,
  keys: string[]
): Promise<{ deleted: number }> {
  if (keys.length === 0) return { deleted: 0 };
  // DeleteObjects supports up to 1000 keys per call.
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      })
    );
    deleted += res.Deleted?.length ?? batch.length;
  }
  return { deleted };
}

export interface R2ObjectSummary {
  key: string;
  size?: number;
  lastModified?: Date;
}

/** Collect every object under a prefix, including folder placeholder keys. */
export async function listAllObjectsUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  cap = 10000
): Promise<{ objects: R2ObjectSummary[]; capped: boolean }> {
  const objects: R2ObjectSummary[] = [];
  let continuation: string | undefined;
  for (;;) {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuation,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      objects.push({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
      });
      if (objects.length >= cap) return { objects, capped: true };
    }
    if (res.IsTruncated && res.NextContinuationToken) {
      continuation = res.NextContinuationToken;
    } else {
      break;
    }
  }
  return { objects, capped: false };
}

/** Collect every object key under a prefix (for folder deletes). */
export async function listAllKeysUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  cap = 10000
): Promise<{ keys: string[]; capped: boolean }> {
  const { objects, capped } = await listAllObjectsUnderPrefix(
    client,
    bucket,
    prefix,
    cap
  );
  return { keys: objects.map((obj) => obj.key), capped };
}

/** Delete a single browsable entry. Folders expand to all keys under the prefix. */
export async function deleteEntry(
  client: S3Client,
  bucket: string,
  entry: R2Entry
): Promise<{ deleted: number; capped?: boolean }> {
  if (entry.type === "file") {
    return deleteKeys(client, bucket, [entry.key]);
  }
  const { keys, capped } = await listAllKeysUnderPrefix(
    client,
    bucket,
    entry.key
  );
  if (keys.length === 0) {
    // Placeholder folder object may exist as the prefix key itself.
    return { deleted: 0, capped };
  }
  const { deleted } = await deleteKeys(client, bucket, keys);
  return { deleted, capped };
}

export async function downloadToBytes(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Uint8Array> {
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const body = res.Body;
  if (!body) throw new Error("Empty response body from R2");
  // Body is a stream in Node; convert to bytes.
  return (
    body as unknown as { transformToByteArray: () => Promise<Uint8Array> }
  ).transformToByteArray();
}

export async function downloadToFile(
  client: S3Client,
  bucket: string,
  key: string,
  destPath: string
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const bytes = await downloadToBytes(client, bucket, key);
  await writeFile(destPath, bytes);
}

export function formatBytes(size?: number): string {
  if (size === undefined) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
