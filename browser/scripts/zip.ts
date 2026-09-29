import { deflateRawSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * A dependency-free ZIP writer (local headers, central directory, EOCD, per
 * the PKZIP spec): AMO needs a real .zip and `Bun.Archive` only writes
 * tar/gzip. Timestamps are fixed at the DOS zero date, so the same files in
 * the same order always produce the same archive.
 */

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  path: string;
  data: Uint8Array;
}

async function collectFiles(dir: string, base = dir): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...(await collectFiles(fullPath, base)));
    } else if (item.isFile()) {
      const data = await readFile(fullPath);
      const zipPath = relative(base, fullPath).split(sepRegex).join("/");
      entries.push({ path: zipPath, data });
    }
  }
  return entries;
}

const sepRegex = /\\/g;

function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const storedData = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // time (DOS zero-date)
    localHeader.writeUInt16LE(0x21, 12); // date: 1980-01-01
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(storedData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBytes, storedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // time
    centralHeader.writeUInt16LE(0x21, 14); // date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(storedData.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + storedData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

/** Zips every file under `sourceDir` (recursively) into `outputPath`, with paths relative to `sourceDir` at the zip root. */
export async function writeZip(sourceDir: string, outputPath: string): Promise<void> {
  const entries = await collectFiles(sourceDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  await Bun.write(outputPath, buildZip(entries));
}
