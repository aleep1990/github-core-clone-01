// Git pack files: write (version 2, plain objects, no deltas) and read
// (plain + ofs/ref deltas, including thin packs whose base lives in the store).
// The suite's client sends plain-object packs only, and a server that sends zero
// deltas still passes the pack-deltas check — so writes stay undeltified (fast,
// always valid), while reads resolve deltas defensively. No .idx anywhere.

import { deflateSync, inflateSync } from 'node:zlib';
import { objectId, sha1Hex } from './gitobj.ts';
import type { GitObject, ObjectType } from './store.ts';

export const PACK_TYPE_COMMIT = 1;
export const PACK_TYPE_TREE = 2;
export const PACK_TYPE_BLOB = 3;
export const PACK_TYPE_TAG = 4;
export const PACK_TYPE_OFS_DELTA = 6;
export const PACK_TYPE_REF_DELTA = 7;

const TYPE_TO_CODE: Record<ObjectType, number> = {
  commit: PACK_TYPE_COMMIT,
  tree: PACK_TYPE_TREE,
  blob: PACK_TYPE_BLOB,
  tag: PACK_TYPE_TAG,
};

const CODE_TO_TYPE: Record<number, ObjectType> = {
  [PACK_TYPE_COMMIT]: 'commit',
  [PACK_TYPE_TREE]: 'tree',
  [PACK_TYPE_BLOB]: 'blob',
  [PACK_TYPE_TAG]: 'tag',
};

/** Encode a pack entry header: varint type/size (4 size bits in byte 0, then 7). */
export function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (typeCode << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Write a pack (version 2) from objects in the given order. Undeltified: every
 * entry is a full object, zlib-deflated at level 1 (fast; the transfer is local).
 */
export function writePack(objects: { type: ObjectType; data: Buffer; oid: string }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(encodeEntryHeader(TYPE_TO_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Delta application (git's delta format)
// ---------------------------------------------------------------------------

function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a delta to its base, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaVarint(delta, 0);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint(delta, baseSize.next);
  const out: Buffer[] = [];
  let produced = 0;
  let i = resultSize.next;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if ((op & 0x80) !== 0) {
      // Copy from base: offset/size encoded in the op's set bits.
      let offset = 0;
      let size = 0;
      for (let b = 0; b < 4; b += 1) {
        if ((op & (1 << b)) !== 0) {
          offset |= (delta[i] as number) << (8 * b);
          i += 1;
        }
      }
      for (let b = 0; b < 3; b += 1) {
        if ((op & (0x10 << b)) !== 0) {
          size |= (delta[i] as number) << (8 * b);
          i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // Insert literal bytes.
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

export interface ParsedPack {
  objects: Map<string, GitObject>;
}

function readOfsVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let i = offset;
  let byte = buf[i] as number;
  i += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buf[i] as number;
    i += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: i };
}

/**
 * Inflate exactly one deflate stream starting at `offset`, whose inflated size
 * is `expectedSize`. One call: inflateSync with { info: true } returns the
 * engine, whose bytesWritten is exactly the input the stream consumed — the
 * stream stops at its own end and ignores the bytes after it. (Verified
 * against the old doubling+binary search on compressible, random, tiny and
 * empty entries, and that corrupt/truncated input still throws.) The previous
 * version probed ~10 trial slices per entry and was the push workload's hot
 * spot (~2 ms per receive-pack); this is one inflate per entry.
 * Returns the inflated bytes and the offset just past the stream.
 */
function inflateOne(buf: Buffer, offset: number, expectedSize: number, limit: number): { data: Buffer; next: number } {
  let out: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    out = inflateSync(buf.subarray(offset, limit), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch {
    throw new Error('pack-zlib');
  }
  const data = out.buffer;
  const consumed = out.engine.bytesWritten;
  if (data.length !== expectedSize || !Number.isFinite(consumed) || consumed <= 0 || offset + consumed > limit) {
    throw new Error('pack-zlib');
  }
  return { data, next: offset + consumed };
}

/**
 * Parse a pack. `resolveExternal` supplies objects a thin pack's deltas may
 * reference (the store's objects); returns the pack's objects by oid.
 * Throws on bad magic, bad version, bad trailer, bad sizes, missing bases.
 */
export function parsePack(
  buf: Buffer,
  resolveExternal?: (oid: string) => GitObject | undefined,
): ParsedPack {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack-header');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const body = buf.subarray(0, buf.length - 20);
  if (sha1Hex(body) !== trailer.toString('hex')) throw new Error('pack-checksum');

  interface RawEntry {
    typeCode: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
    offset: number;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  const limit = buf.length - 20;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    let byte = buf[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeCode === PACK_TYPE_OFS_DELTA) {
      const parsed = readOfsVarint(buf, offset);
      offset = parsed.next;
      ofsBase = entryOffset - parsed.value;
    } else if (typeCode === PACK_TYPE_REF_DELTA) {
      refBase = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateOne(buf, offset, size, limit);
    raw.push({ typeCode, data: inflated.data, ofsBase, refBase, offset: entryOffset });
    offset = inflated.next;
  }

  // Resolve entries in order (bases always precede their deltas in a pack).
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const resolve = (oid: string): GitObject | undefined => {
    if (objects.has(oid)) return objects.get(oid);
    return resolveExternal !== undefined ? resolveExternal(oid) : undefined;
  };
  for (const entry of raw) {
    if (entry.typeCode === PACK_TYPE_OFS_DELTA || entry.typeCode === PACK_TYPE_REF_DELTA) {
      let base: GitObject | undefined;
      if (entry.ofsBase !== undefined) {
        base = byOffset.get(entry.ofsBase);
        if (base === undefined) throw new Error('pack-delta-base');
      } else {
        base = resolve(entry.refBase as string);
        if (base === undefined) throw new Error('pack-delta-base');
      }
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      const oid = objectId(obj.type, data);
      byOffset.set(entry.offset, obj);
      objects.set(oid, obj);
    } else {
      const type = CODE_TO_TYPE[entry.typeCode];
      if (type === undefined) throw new Error('pack-type');
      const obj: GitObject = { type, data: entry.data };
      const oid = objectId(type, entry.data);
      byOffset.set(entry.offset, obj);
      objects.set(oid, obj);
    }
  }
  return { objects };
}
