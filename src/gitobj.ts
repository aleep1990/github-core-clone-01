// Git object model: SHA-1 ids, commit/tree/blob/tag encode + parse.
// Written from the git object format itself (see the kit's checks-git brief for the
// exact shapes the suite pushes and clones back). No git binary, stdlib only.

import { createHash } from 'node:crypto';
import type { ObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: SHA-1 over "<type> <size>\0" + bytes. */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The full on-disk form of an object (header + bytes), for hashing / storage. */
export function encodeObject(type: ObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([header, data]);
}

export function isValidOid(oid: string): boolean {
  return /^[0-9a-f]{40}$/i.test(oid);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.author}\n`;
  out += `committer ${info.committer}\n`;
  out += `\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: byte order of the name, a directory compared as if ending in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tags (annotated)
// ---------------------------------------------------------------------------

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(info: TagInfo): Buffer {
  const out = `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export interface ObjectStore {
  get(oid: string): { type: ObjectType; data: Buffer } | undefined;
}

/**
 * Walk the closure reachable from `tips`, following commit -> tree/parents,
 * tag -> target, tree -> entries (gitlink 160000 skipped). Returns the set of
 * oids in walk order. `stopAt` oids are not traversed (already-held boundary).
 */
export function collectReachable(
  objects: ObjectStore,
  tips: string[],
  stopAt?: Set<string>,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack: string[] = [...tips].reverse();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    if (stopAt !== undefined && stopAt.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    order.push(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
      stack.push(info.tree);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i] as TreeEntry;
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return order;
}

/** The first-parent-ish commit chain from `tip`, newest first (linear histories). */
export function commitChain(objects: ObjectStore, tip: string, maxDepth?: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    if (maxDepth !== undefined && out.length >= maxDepth) break;
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    seen.add(current);
    out.push(current);
    const info = parseCommit(obj.data);
    current = info.parents[0];
  }
  return out;
}

/** Nearest common ancestor of two commits (by walking both histories). */
export function mergeBase(objects: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set(commitChain(objects, a));
  let current: string | undefined = b;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (ancestorsA.has(current)) return current;
    seen.add(current);
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    current = parseCommit(obj.data).parents[0];
  }
  return null;
}
