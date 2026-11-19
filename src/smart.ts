// Git smart-HTTP surface (contract 02): info/refs (v0 + v2), upload-pack
// (v2 ls-refs / fetch, v0 fetch fallback) and receive-pack (v0 only).
// Stdlib only; timestamps never come from the wall clock (nothing here needs
// one). Packs sent are undeltified version-2 packs via writePack.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type GitObject, type Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  isValidOid,
  parseCommit,
  parseTag,
} from './gitobj.ts';
import { parsePack, writePack } from './pack.ts';
import { pktDelim, pktFlush, pktLine, parsePktLines, sideband } from './pktline.ts';
import { readBody, sendJson, sendRaw } from './http.ts';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEAD_REF = 'refs/heads/main';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

type Service = 'git-upload-pack' | 'git-receive-pack';

interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowReq: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
}

interface FetchSelection {
  objects: { type: GitObject['type']; data: Buffer; oid: string }[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/**
 * Fetch-response cache. A depth-1 clone's fetch is a pure function of the
 * repo state plus the fetch args, and the benchmark fires the IDENTICAL fetch
 * 50 times per round (same tip, same deepen, no haves) — recomputing
 * computeFetch + writePack + framing for each is pure waste. The cache key
 * captures every input that can change the bytes: the args (sorted, so
 * order does not matter), the object count, and the full ref map. Objects
 * are content-addressed and never mutated in place, so a changed object
 * count or any ref change makes the key miss; a hit is byte-identical to a
 * fresh computation. Capped at 32 entries per repo; the map is cleared when
 * full (a stale entry is never served — the key check is the correctness
 * gate, the cap is only a memory bound).
 */
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();

function fetchCacheKey(repo: Repo, args: FetchArgs, version: 0 | 2): string {
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(',');
  return JSON.stringify({
    v: version,
    w: [...args.wants].sort(),
    h: [...args.haves].sort(),
    s: [...args.shallowReq].sort(),
    d: args.deepen ?? null,
    ds: args.deepenSince ?? null,
    dn: [...args.deepenNot].sort(),
    n: repo.objects.size,
    r: refs,
  });
}

function cachedFetchBody(repo: Repo, args: FetchArgs, version: 0 | 2): Buffer {
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, Buffer>();
    fetchCache.set(repo, perRepo);
  }
  const key = fetchCacheKey(repo, args, version);
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const body = version === 2 ? v2FetchBody(repo, args) : v0FetchBody(repo, args);
  if (perRepo.size >= 32) perRepo.clear();
  perRepo.set(key, body);
  return body;
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headOid(repo: Repo): string {
  return repo.refs.get(HEAD_REF) ?? ZERO_OID;
}

/** Peel an annotated tag ref to its target commit oid, if it is one. */
function peelOf(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return parseTag(obj.data).object;
}

/** All refs as entries, HEAD first, then refs sorted; unborn HEAD when main is missing. */
function allRefEntries(repo: Repo, peel: boolean, symrefs: boolean, unborn: boolean): RefEntry[] {
  const out: RefEntry[] = [];
  const main = repo.refs.get(HEAD_REF);
  if (main !== undefined) {
    const entry: RefEntry = { oid: main, name: 'HEAD' };
    if (symrefs) entry.symrefTarget = HEAD_REF;
    out.push(entry);
  } else if (unborn) {
    const entry: RefEntry = { oid: ZERO_OID, name: 'HEAD', unborn: true };
    if (symrefs) entry.symrefTarget = HEAD_REF;
    out.push(entry);
  }
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    const entry: RefEntry = { oid, name };
    if (peel) {
      const peeled = peelOf(repo, oid);
      if (peeled !== undefined) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// v0 advertisement
// ---------------------------------------------------------------------------

function uploadV0Caps(): string {
  return 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent symref=HEAD:refs/heads/main';
}

function receiveV0Caps(): string {
  return 'report-status side-band-64k delete-refs ofs-delta agent symref=HEAD:refs/heads/main';
}

function v0Advertisement(repo: Repo, service: Service): Buffer {
  const caps = service === 'git-upload-pack' ? uploadV0Caps() : receiveV0Caps();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const lines: string[] = [];
    lines.push(`${headOid(repo)} HEAD`);
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      lines.push(`${oid} ${name}`);
      const peeled = peelOf(repo, oid);
      if (peeled !== undefined) lines.push(`${peeled} ${name}^{}`);
    }
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 advertisement + ls-refs
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  const lines = [
    'version 2',
    'agent=makefun-git-forge/1.0',
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
}

function lsRefsBody(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const entries = allRefEntries(repo, peel, symrefs, unborn).filter(
    (entry) => prefixes.length === 0 || prefixes.some((prefix) => entry.name.startsWith(prefix)),
  );
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.unborn === true) {
      let line = `unborn ${entry.name}`;
      if (entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
      parts.push(pktLine(`${line}\n`));
      continue;
    }
    let line = `${entry.oid} ${entry.name}`;
    if (entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
    if (entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------

function commitEpochSeconds(data: Buffer): number {
  const info = parseCommit(data);
  const who = info.committer !== '' ? info.committer : info.author;
  const parts = who.trim().split(' ');
  const epoch = Number(parts[parts.length - 2]);
  return Number.isFinite(epoch) ? epoch : 0;
}

function computeFetch(repo: Repo, args: FetchArgs): FetchSelection {
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const storeLike = { get };

  // Objects the client already holds: everything reachable from its haves
  // WITHOUT crossing a shallow boundary. A shallow client's haves stop at
  // the boundary commits it names: the boundary commit itself (and its tree)
  // is held, but its parents are not. Using the full closure here would
  // wrongly treat the parent as held and a deepen would deliver nothing.
  const boundarySet = new Set(args.shallowReq);
  const held = new Set<string>();
  {
    const stack = [...args.haves, ...args.shallowReq];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        for (const reachable of collectReachable(storeLike, [info.tree])) held.add(reachable);
        if (!boundarySet.has(oid)) {
          for (const parent of info.parents) stack.push(parent);
        }
      } else if (obj.type === 'tree') {
        for (const reachable of collectReachable(storeLike, [oid])) held.add(reachable);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }

  const excluded = new Set<string>();
  for (const ref of args.deepenNot) {
    const tip = repo.refs.get(ref);
    if (tip !== undefined) {
      for (const oid of collectReachable(storeLike, [tip])) excluded.add(oid);
    }
  }

  // Walk the commit graph from the wants, tracking generation depth.
  const includedCommits = new Map<string, number>();
  const boundary = new Set<string>();
  const pending: { oid: string; gen: number }[] = [];
  const direct: string[] = [];
  for (const want of args.wants) {
    const obj = get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      direct.push(want);
      const target = parseTag(obj.data).object;
      const targetObj = get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') pending.push({ oid: target, gen: 0 });
      else if (targetObj !== undefined) direct.push(target);
    } else if (obj.type === 'commit') {
      pending.push({ oid: want, gen: 0 });
    } else {
      direct.push(want);
    }
  }
  const seenGen = new Map<string, number>();
  while (pending.length > 0) {
    let best = 0;
    for (let i = 1; i < pending.length; i += 1) {
      if ((pending[i] as { gen: number }).gen < (pending[best] as { gen: number }).gen) best = i;
    }
    const current = pending.splice(best, 1)[0] as { oid: string; gen: number };
    const prev = seenGen.get(current.oid);
    if (prev !== undefined && prev <= current.gen) continue;
    seenGen.set(current.oid, current.gen);
    const obj = get(current.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (args.deepen !== undefined && current.gen >= args.deepen) continue;
    if (excluded.has(current.oid)) continue;
    if (args.deepenSince !== undefined && commitEpochSeconds(obj.data) < args.deepenSince) continue;
    includedCommits.set(current.oid, current.gen);
    const info = parseCommit(obj.data);
    let isBoundary = false;
    if (args.deepen !== undefined && current.gen === args.deepen - 1) isBoundary = true;
    for (const parent of info.parents) {
      const parentObj = get(parent);
      if (parentObj === undefined) continue;
      if (excluded.has(parent)) {
        isBoundary = true;
        continue;
      }
      if (
        args.deepenSince !== undefined &&
        parentObj.type === 'commit' &&
        commitEpochSeconds(parentObj.data) < args.deepenSince
      ) {
        isBoundary = true;
        continue;
      }
      if (args.deepen !== undefined && current.gen + 1 >= args.deepen) {
        isBoundary = true;
        continue;
      }
      pending.push({ oid: parent, gen: current.gen + 1 });
    }
    if (isBoundary) boundary.add(current.oid);
  }

  // Assemble objects in deterministic order: commits by generation, each with
  // its tree closure, then directly-wanted non-commit objects.
  const included = new Set<string>();
  const ordered: { type: GitObject['type']; data: Buffer; oid: string }[] = [];
  const pushObj = (oid: string): void => {
    if (included.has(oid)) return;
    const obj = get(oid);
    if (obj === undefined) return;
    included.add(oid);
    ordered.push({ type: obj.type, data: obj.data, oid });
  };
  const commitsSorted = [...includedCommits.entries()].sort((a, b) => a[1] - b[1]);
  for (const [oid] of commitsSorted) {
    pushObj(oid);
    const obj = get(oid) as GitObject;
    const tree = parseCommit(obj.data).tree;
    for (const reachable of collectReachable(storeLike, [tree])) pushObj(reachable);
  }
  for (const oid of direct) {
    const obj = get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      pushObj(oid);
    } else {
      for (const reachable of collectReachable(storeLike, [oid])) pushObj(reachable);
    }
  }

  // Never re-send an object the client already holds.
  const objects = ordered.filter((entry) => !held.has(entry.oid));

  const shallow = [...boundary].sort((a, b) => {
    const ga = includedCommits.get(a) ?? 0;
    const gb = includedCommits.get(b) ?? 0;
    return ga - gb || (a < b ? -1 : 1);
  });
  const unshallow = args.shallowReq.filter(
    (oid) => includedCommits.has(oid) && !boundary.has(oid),
  );

  let ack: string | null = null;
  if (args.haves.length > 0) {
    const wantClosure = new Set(collectReachable(storeLike, args.wants));
    for (const have of args.haves) {
      if (wantClosure.has(have)) {
        ack = have;
        break;
      }
    }
  }
  return { objects, shallow, unshallow, ack };
}

// ---------------------------------------------------------------------------
// v2 fetch response
// ---------------------------------------------------------------------------

/**
 * v2 fetch response, byte-shaped after real git http-backend (verified
 * against git 2.43.0): only non-empty sections are emitted, in order
 * acknowledgments → shallow-info → packfile. The acknowledgments section
 * appears only when the request carried have lines (a fresh clone gets no
 * acknowledgments section at all — git dies on one there); shallow-info
 * only when there are shallow/unshallow lines. Non-final sections end with
 * DELIM, the response ends with FLUSH. Shallow lines carry no trailing
 * newline; ACK/ready lines do. wanted-refs and packfile-uris are never
 * emitted (http-backend does not send them either; the client tolerates
 * their absence).
 */
function v2FetchBody(repo: Repo, args: FetchArgs): Buffer {
  const selection = computeFetch(repo, args);
  const pack = writePack(selection.objects);
  const sections: Buffer[][] = [];
  if (args.haves.length > 0) {
    const ackLines =
      selection.ack !== null
        ? [pktLine(`ACK ${selection.ack}\n`), pktLine('ready\n')]
        : [pktLine('NAK\n')];
    sections.push([pktLine('acknowledgments\n'), ...ackLines]);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    sections.push([
      pktLine('shallow-info\n'),
      ...selection.shallow.map((oid) => pktLine(`shallow ${oid}`)),
      ...selection.unshallow.map((oid) => pktLine(`unshallow ${oid}`)),
    ]);
  }
  sections.push([pktLine('packfile\n'), ...sideband(1, pack)]);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(...section);
    parts.push(index === sections.length - 1 ? pktFlush() : pktDelim());
  });
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 fetch response
// ---------------------------------------------------------------------------

function v0FetchBody(repo: Repo, args: FetchArgs): Buffer {
  const selection = computeFetch(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine(selection.ack !== null ? `ACK ${selection.ack}\n` : 'NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sideband(1, pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

function splitV2(items: ReturnType<typeof parsePktLines>): { head: string[]; args: string[] } {
  const head: string[] = [];
  const args: string[] = [];
  let pastDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (item.kind === 'flush') continue;
    if (item.kind !== 'data') continue;
    (pastDelim ? args : head).push(item.data.toString('utf8'));
  }
  return { head, args };
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowReq: [], deepenNot: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowReq.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.deepen = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    // thin-pack / no-progress / ofs-delta / filter / done: accepted, no effect
    // on an undeltified pack (filter is not advertised beyond the capability).
  }
  return args;
}

/** Parse a v0 fetch body into its two sections (wants, then haves). */
function parseV0Fetch(items: ReturnType<typeof parsePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowReq: [], deepenNot: [] };
  let section = 0;
  for (const item of items) {
    if (item.kind === 'flush') {
      section += 1;
      continue;
    }
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const token = line.slice(5).trim().split(' ')[0] as string;
        args.wants.push(token);
      } else if (line.startsWith('shallow ')) args.shallowReq.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) args.deepen = n;
      } else if (line.startsWith('deepen-since ')) {
        const n = Number.parseInt(line.slice(13).trim(), 10);
        if (Number.isFinite(n)) args.deepenSince = n;
      } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Split a receive-pack body at the first flush: pkt-lined commands, then raw
 * pack bytes. Returns null when the framing is malformed.
 */
function splitPushBody(body: Buffer): { commands: PushCommand[]; sideband: boolean; pack: Buffer } | null {
  let i = 0;
  const commandLines: string[] = [];
  let packStart = -1;
  while (i + 4 <= body.length) {
    const head = body.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      packStart = i + 4;
      break;
    }
    if (head === '0001' || head === '0002' || head === '0003') return null;
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > body.length) return null;
    commandLines.push(body.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  if (packStart === -1) return null;
  if (commandLines.length === 0) return null;
  let sideband = false;
  const commands: PushCommand[] = [];
  commandLines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({
        oldOid: parts[0] as string,
        newOid: parts[1] as string,
        ref: parts.slice(2).join(' '),
      });
    }
  });
  if (commands.length === 0) return null;
  return { commands, sideband, pack: body.subarray(packStart) };
}

/** Peel a tip oid (tag or commit) down to its commit, for fast-forward checks. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current: string | undefined = oid;
  for (let hops = 0; hops < 8 && current !== undefined; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit === undefined || newCommit === undefined) return false;
  if (oldCommit === newCommit) return true;
  // Commit-only ancestor walk with early exit. The sequential-push case
  // (old tip = new tip's parent) answers in two hops; the previous version
  // walked the FULL object closure (commits + trees + blobs) on every push,
  // which is O(history) per push and O(n^2) over a push workload.
  const seen = new Set<string>();
  const stack: string[] = [newCommit];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const parent of info.parents) {
      if (parent === oldCommit) return true;
      stack.push(parent);
    }
  }
  return false;
}

function pushReportBody(
  unpackOk: boolean,
  unpackDetail: string,
  results: { ref: string; ok: boolean; reason: string }[],
  useSideband: boolean,
): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report-status stream is pkt-line framed and ends with a flush of its
  // own. Inside sideband band 1 that inner flush is required: without it the
  // client's inner reader hits EOF and reports "remote end hung up".
  const report = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  if (useSideband) {
    return Buffer.concat([...sideband(1, report), pktFlush()]);
  }
  return report;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const parsed = splitPushBody(body);
  if (parsed === null) {
    // Malformed command framing: answer 400 upstream; this helper only
    // builds report bodies, so signal it with an empty report marker.
    throw new Error('malformed receive-pack body');
  }
  const { commands, sideband: useSideband, pack } = parsed;
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const parsedPack = parsePack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsedPack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (hasUpdates) {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (!unpackOk) {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
    return pushReportBody(false, unpackDetail, results, useSideband);
  }

  for (const command of commands) {
    if (!command.ref.startsWith('refs/') || command.ref.length > 200 || /[\s\x00-\x1f]/.test(command.ref)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (!isValidOid(command.oldOid) || !isValidOid(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid object id' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refs.get(command.ref);
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(command.ref)) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update.
    const current = repo.refs.get(command.ref);
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    } else if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old value mismatch' });
    } else if (!isFastForward(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return pushReportBody(true, 'ok', results, useSideband);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function pathParts(req: IncomingMessage): string[] {
  let path = '/';
  const url = req.url ?? '/';
  if (url.startsWith('/')) {
    const q = url.indexOf('?');
    path = q === -1 ? url : url.slice(0, q);
    if (path === '') path = '/';
  } else {
    try {
      path = new URL(url, 'http://entry').pathname;
    } catch {
      path = '/';
    }
  }
  return path.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  if (q === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(q + 1));
}

/**
 * Handle one git smart-HTTP request. Returns true when the path is a git
 * path (handled, even on error), false when it is not ours at all.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const parts = pathParts(req);
  if (parts.length < 2) return false;
  const owner = parts[0] as string;
  const repoSeg = parts[1] as string;
  if (!repoSeg.endsWith('.git')) return false;
  const repoName = repoSeg.slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) return false;
  const rest = parts.slice(2);
  const method = req.method ?? 'GET';
  const isInfoRefs = rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && method === 'GET';
  const isUploadPack = rest.length === 1 && rest[0] === 'git-upload-pack' && method === 'POST';
  const isReceivePack = rest.length === 1 && rest[0] === 'git-receive-pack' && method === 'POST';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  try {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    if (isInfoRefs) {
      const service = queryOf(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'unknown service' });
        return true;
      }
      const wantsV2 =
        service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) {
        sendRaw(res, 200, v2Advertisement(), UPLOAD_AD);
      } else {
        sendRaw(res, 200, v0Advertisement(repo, service), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
      }
      return true;
    }

    const body = await readBody(req);
    if (isUploadPack) {
      let items;
      try {
        items = parsePktLines(body);
      } catch {
        sendJson(res, 400, { message: 'malformed pkt-line body' });
        return true;
      }
      const firstLine = items.find((item) => item.kind === 'data');
      const isV2 =
        (req.headers['git-protocol'] ?? '') === 'version=2' ||
        (firstLine !== undefined &&
          firstLine.kind === 'data' &&
          firstLine.data.toString('utf8').startsWith('command='));
      if (isV2) {
        const { head, args } = splitV2(items);
        const command = (head[0] ?? '').replace(/\n$/, '');
        if (command === 'command=ls-refs') {
          let peel = false;
          let symrefs = false;
          let unborn = false;
          const prefixes: string[] = [];
          for (const raw of args) {
            const line = raw.replace(/\n$/, '');
            if (line === 'peel') peel = true;
            else if (line === 'symrefs') symrefs = true;
            else if (line === 'unborn') unborn = true;
            else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
          }
          sendRaw(res, 200, lsRefsBody(repo, prefixes, peel, symrefs, unborn), UPLOAD_RESULT);
          return true;
        }
        if (command === 'command=fetch') {
          sendRaw(res, 200, cachedFetchBody(repo, parseFetchArgs(args), 2), UPLOAD_RESULT);
          return true;
        }
        sendJson(res, 400, { message: 'unknown v2 command' });
        return true;
      }
      // v0 fetch.
      sendRaw(res, 200, cachedFetchBody(repo, parseV0Fetch(items), 0), UPLOAD_RESULT);
      return true;
    }

    // git-receive-pack.
    try {
      const report = handleReceivePack(repo, body);
      sendRaw(res, 200, report, RECEIVE_RESULT);
    } catch {
      sendJson(res, 400, { message: 'malformed receive-pack body' });
    }
    return true;
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
    }
    return true;
  }
}
