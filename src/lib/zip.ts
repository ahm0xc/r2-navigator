import { open, unlink, type FileHandle } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0 — deflate support.
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface CentralRecord {
  name: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  time: number;
  date: number;
  offset: number;
  isDirectory: boolean;
}

/**
 * Normalise a key into a zip-safe path. Extraction tools trust entry names,
 * so drop empty / `.` / `..` segments (path traversal) and NUL bytes.
 */
export function safeZipPath(name: string): string {
  const isDirectory = name.endsWith("/");
  const parts = name
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .map((part) => part.replace(/\0/g, "_"));
  const joined = parts.join("/");
  if (!joined) return "";
  return isDirectory ? `${joined}/` : joined;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const index = (crc ^ data[i]!) & 0xff;
    crc = table[index]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Minimal streaming zip writer: each entry is compressed and appended to disk
 * as it arrives, so we only hold one object in memory at a time. The central
 * directory is written on close.
 */
export class ZipWriter {
  private readonly records: CentralRecord[] = [];
  private offset = 0;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    readonly path: string
  ) {}

  static async create(destPath: string): Promise<ZipWriter> {
    const handle = await open(destPath, "w");
    return new ZipWriter(handle, destPath);
  }

  async addFile(
    name: string,
    data: Uint8Array,
    mtime: Date = new Date()
  ): Promise<void> {
    const zipPath = safeZipPath(name);
    if (!zipPath || zipPath.endsWith("/")) {
      throw new Error(`Invalid zip entry name: ${name}`);
    }
    if (data.length > 0xffffffff) {
      throw new Error(`File too large for a zip archive: ${zipPath}`);
    }

    const compressed = deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(data);
    const { time, date } = dosDateTime(mtime);
    const nameBuf = Buffer.from(zipPath, "utf8");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    const recordOffset = this.offset;
    await this.write(header);
    await this.write(nameBuf);
    await this.write(asBuffer(payload));

    this.records.push({
      name: nameBuf,
      crc,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      method,
      time,
      date,
      offset: recordOffset,
      isDirectory: false,
    });
  }

  async addDirectory(
    name: string,
    mtime: Date = new Date()
  ): Promise<void> {
    const dirName = safeZipPath(name.endsWith("/") ? name : `${name}/`);
    if (!dirName) return;
    const { time, date } = dosDateTime(mtime);
    const nameBuf = Buffer.from(dirName, "utf8");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(METHOD_STORE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    const recordOffset = this.offset;
    await this.write(header);
    await this.write(nameBuf);

    this.records.push({
      name: nameBuf,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      method: METHOD_STORE,
      time,
      date,
      offset: recordOffset,
      isDirectory: true,
    });
  }

  /** Write the central directory and close the file. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.records.length > 0xffff) {
      throw new Error("Too many files for a zip archive (max 65,535).");
    }

    const centralStart = this.offset;
    for (const record of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      header.writeUInt16LE(0x031e, 4); // Made by: Unix, zip 3.0.
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(record.time, 12);
      header.writeUInt16LE(record.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(0, 30); // Extra length.
      header.writeUInt16LE(0, 32); // Comment length.
      header.writeUInt16LE(0, 34); // Disk number.
      header.writeUInt16LE(0, 36); // Internal attributes.
      header.writeUInt32LE(
        record.isDirectory
          ? ((0o40755 << 16) | 0x10) >>> 0
          : (0o100644 << 16) >>> 0,
        38
      );
      header.writeUInt32LE(record.offset, 42);
      await this.write(header);
      await this.write(record.name);
    }

    const centralSize = this.offset - centralStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
    end.writeUInt16LE(0, 4); // Disk number.
    end.writeUInt16LE(0, 6); // Central directory disk.
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20); // Comment length.
    await this.write(end);

    this.closed = true;
    await this.handle.close();
  }

  /** Close the handle and remove the partial archive. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.handle.close();
    } finally {
      await unlink(this.path).catch(() => undefined);
    }
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.offset + buf.length > 0xffffffff) {
      throw new Error("Archive exceeds the 4 GB zip limit.");
    }
    await this.handle.write(buf);
    this.offset += buf.length;
  }
}
