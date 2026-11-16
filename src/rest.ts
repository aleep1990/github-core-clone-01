// REST v3 surface for the github-core-clone-01 forge.
// One handler: handleRest(req, res) returns true when the path starts with
// /api/v3 (it answered), false otherwise (caller routes elsewhere).
// Determinism: no Date.now()/new Date()/Math.random(); timestamps from
// nowIso(), commit epochs from commitEpoch(seq).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER, nowIso, commitEpoch, type Repo, type Issue, type Pull } from './store.ts';
import { sendJson, sendRaw, jsonError, readBody, parseJsonBody, authViewer, pathSegments, queryOf } from './http.ts';
import { objectId, buildCommit, buildTree, parseCommit, parseTree, commitChain, mergeBase, isValidOid, type TreeEntry } from './gitobj.ts';

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intParam(q: URLSearchParams, name: string, def: number): number {
  const raw = q.get(name);
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; pageNum: number; perPage: number; totalPages: number } {
  const perPage = Math.min(intParam(q, 'per_page', 30), 100);
  const pageNum = intParam(q, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage, totalPages };
}

function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
  const host = req.headers.host ?? 'localhost';
  const parts: string[] = [];
  const urlFor = (p: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${p}`;
  if (pageNum < totalPages) parts.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) parts.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  void q;
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): JsonObj {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1002, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: nowIso(),
    updated_at: nowIso(),
    pushed_at: nowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_pull_requests: true,
  };
}

function issueJson(issue: Issue): JsonObj {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: issue.comments.length,
  };
}

function pullJson(pull: Pull): JsonObj {
  const out: JsonObj = {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  return out;
}

// ---------------------------------------------------------------------------
// Git object helpers (all state lives in repo.objects / repo.refs)
// ---------------------------------------------------------------------------

function storeObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const oid = objectId(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

function authorLine(epoch: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
}

/** Resolve a branch name / full ref / commit oid to a commit oid. */
function resolveRef(repo: Repo, ref: string | null | undefined): string | undefined {
  if (ref === null || ref === undefined || ref === '') return undefined;
  if (ref.startsWith('refs/heads/')) return repo.refs.get(ref);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (isValidOid(ref)) {
    const obj = repo.objects.get(ref.toLowerCase());
    if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  }
  return undefined;
}

function tipOf(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function treeOfCommit(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Flat map path -> {oid, mode} for every file in a tree. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function flatFilesAt(repo: Repo, tip: string | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (tip === undefined) return out;
  const tree = treeOfCommit(repo, tip);
  if (tree === undefined) return out;
  flattenTree(repo, tree, '', out);
  return out;
}

/** Rebuild nested trees from a flat file map; stores every tree; returns root oid. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const buildDir = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: buildDir(childPrefix) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return buildDir('');
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const seq = repo.nextCommitSeq;
  repo.nextCommitSeq += 1;
  const epoch = commitEpoch(seq);
  const line = authorLine(epoch);
  const data = buildCommit({ tree: treeOid, parents, author: line, committer: line, message });
  return storeObject(repo, 'commit', data);
}

/** Lookup a path inside a tree: returns {kind, oid} or undefined. */
function lookupPath(repo: Repo, treeOid: string, parts: string[]): { kind: 'file' | 'dir'; oid: string; mode: string } | undefined {
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const name = parts[i] as string;
    const entry = parseTree(obj.data).find((e) => e.name === name);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const l of oldLines) oldCounts.set(l, (oldCounts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCounts.get(l) ?? 0;
    if (c > 0) oldCounts.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCounts.values()) deletions += c;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const segs = pathSegments(req);
  if (segs[0] !== 'api' || segs[1] !== 'v3') return false;
  const method = req.method ?? 'GET';
  const q = queryOf(req);

  try {
    // Root + meta: starter behavior, no auth required.
    if (method === 'GET' && (segs.length === 2 || (segs.length === 3 && segs[2] === ''))) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    if (method === 'GET' && segs.length === 3 && segs[2] === 'meta') {
      sendJson(res, 200, { installed_version: '0.1.0' });
      return true;
    }

    // Everything else requires a token.
    const viewer = authViewer(req);
    if (viewer === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    // Read + parse a JSON body for methods that carry one.
    let body: unknown = undefined;
    let hasBody = false;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        hasBody = true;
        try {
          body = parseJsonBody(raw);
        } catch {
          jsonError(res, 400, 'Malformed JSON in request body');
          return true;
        }
      }
    }
    void hasBody;
    const b: JsonObj = isObj(body) ? body : {};

    // GET /user
    if (method === 'GET' && segs.length === 3 && segs[2] === 'user') {
      sendJson(res, 200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User', avatar_url: '' });
      return true;
    }

    // POST /user/repos + GET /user/repos
    if (segs.length === 3 && segs[2] === 'user' && false) {
      // unreachable guard, kept for clarity
    }
    if (method === 'POST' && segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') {
        jsonError(res, 422, 'name is required');
        return true;
      }
      if (store.getRepo(viewer.login, name) !== undefined) {
        jsonError(res, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(
        viewer.login,
        name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET' && segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
      const all = store.listRepos(viewer.login);
      const { page, pageNum, perPage, totalPages } = paginate(all, q);
      const link = linkHeader(req, '/api/v3/user/repos', q, pageNum, perPage, totalPages);
      sendJson(res, 200, page.map((r) => repoJson(r)), { link });
      return true;
    }

    // /repos/{owner}/{repo}[...]
    if (segs.length >= 4 && segs[2] === 'repos') {
      const owner = segs[3] as string;
      const repoName = segs[4] as string;
      // Foreign owner: 404, never 403 — even when the repo does not exist.
      if (owner !== viewer.login) {
        jsonError(res, 404, 'Not Found');
        return true;
      }
      const repo = store.getRepo(owner, repoName);
      const rest = segs.slice(5);

      // GET / PATCH / DELETE /repos/{o}/{r}
      if (rest.length === 0) {
        if (method === 'GET') {
          if (repo === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, repoJson(repo));
          return true;
        }
        if (method === 'PATCH') {
          if (repo === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (typeof b.description === 'string') repo.description = b.description;
          sendJson(res, 200, repoJson(repo));
          return true;
        }
        if (method === 'DELETE') {
          if (repo === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          store.deleteRepo(owner, repoName);
          sendRaw(res, 204, Buffer.alloc(0), 'application/json; charset=utf-8');
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }
      if (repo === undefined) {
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // POST /repos/{o}/{r}/git/refs
      if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha.toLowerCase() : '';
        if (!ref.startsWith('refs/heads/') || !isValidOid(sha)) {
          jsonError(res, 422, 'Invalid ref or sha');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          jsonError(res, 422, 'sha not found');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }

      // GET /repos/{o}/{r}/branches
      if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
        const out: JsonObj[] = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
        }
        out.sort((a, c) => String(a.name).localeCompare(String(c.name)));
        sendJson(res, 200, out);
        return true;
      }

      // GET /repos/{o}/{r}/commits
      if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
        const refParam = q.get('sha');
        let tip: string | undefined;
        if (refParam !== null) tip = resolveRef(repo, refParam);
        else tip = tipOf(repo, repo.defaultBranch);
        if (tip === undefined) {
          // Unborn repo: empty list.
          sendJson(res, 200, []);
          return true;
        }
        const chain = commitChain(repo.objects, tip);
        const out = chain.map((sha) => {
          const obj = repo.objects.get(sha);
          const info = obj !== undefined ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
          return { sha, commit: { message: info.message, author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() } }, parents: info.parents.map((p) => ({ sha: p })) };
        });
        sendJson(res, 200, out);
        return true;
      }

      // Contents: /repos/{o}/{r}/contents[/{path...}]
      if (rest.length >= 1 && rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        if (method === 'GET') {
          const refParam = q.get('ref');
          let tip: string | undefined;
          if (refParam !== null) tip = resolveRef(repo, refParam);
          else tip = tipOf(repo, repo.defaultBranch);
          if (tip === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          const treeOid = treeOfCommit(repo, tip);
          if (treeOid === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (filePath === '') {
            const obj = repo.objects.get(treeOid);
            const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
            sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid })));
            return true;
          }
          const parts = filePath.split('/').filter((s) => s.length > 0);
          const found = lookupPath(repo, treeOid, parts);
          if (found === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (found.kind === 'dir') {
            const obj = repo.objects.get(found.oid);
            const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
            sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${filePath}/${e.name}`, sha: e.oid })));
            return true;
          }
          const blob = repo.objects.get(found.oid);
          const bytes = blob !== undefined ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            name: parts[parts.length - 1],
            path: filePath,
            sha: found.oid,
            size: bytes.length,
            encoding: 'base64',
            content: bytes.toString('base64'),
          });
          return true;
        }
        if (method === 'PUT') {
          const message = typeof b.message === 'string' ? b.message : '';
          const contentB64 = typeof b.content === 'string' ? b.content : '';
          if (filePath === '' || contentB64 === '') {
            jsonError(res, 400, 'content is required');
            return true;
          }
          let bytes: Buffer;
          try {
            bytes = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
          } catch {
            jsonError(res, 400, 'content is not valid base64');
            return true;
          }
          const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
          let tip = tipOf(repo, branch);
          if (tip === undefined && branch !== repo.defaultBranch) tip = tipOf(repo, repo.defaultBranch);
          const flat = flatFilesAt(repo, tip);
          const existing = flat.get(filePath);
          const givenSha = typeof b.sha === 'string' ? b.sha.toLowerCase() : '';
          const isUpdate = existing !== undefined;
          if (isUpdate) {
            if (givenSha === '' || givenSha !== existing.oid.toLowerCase()) {
              jsonError(res, 409, 'sha does not match the current blob');
              return true;
            }
          }
          const blobOid = storeObject(repo, 'blob', bytes);
          flat.set(filePath, { oid: blobOid, mode: '100644' });
          const rootTree = buildTreeFromFlat(repo, flat);
          const parents = tip !== undefined ? [tip] : [];
          const commitOid = makeCommit(repo, rootTree, parents, message);
          repo.refs.set(`refs/heads/${branch}`, commitOid);
          sendJson(res, isUpdate ? 200 : 201, {
            content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: bytes.length, encoding: 'base64', content: contentB64 },
            commit: { sha: commitOid, message },
          });
          return true;
        }
        if (method === 'DELETE') {
          const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
          const tip = tipOf(repo, branch);
          if (tip === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          const flat = flatFilesAt(repo, tip);
          const existing = flat.get(filePath);
          if (existing === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          const givenSha = typeof b.sha === 'string' ? b.sha.toLowerCase() : '';
          if (givenSha !== '' && givenSha !== existing.oid.toLowerCase()) {
            jsonError(res, 409, 'sha does not match the current blob');
            return true;
          }
          flat.delete(filePath);
          const rootTree = buildTreeFromFlat(repo, flat);
          const message = typeof b.message === 'string' ? b.message : '';
          const commitOid = makeCommit(repo, rootTree, [tip], message);
          repo.refs.set(`refs/heads/${branch}`, commitOid);
          sendJson(res, 200, { commit: { sha: commitOid, message } });
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // POST /repos/{o}/{r}/labels
      if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color : '';
        if (name === '') { jsonError(res, 422, 'name is required'); return true; }
        repo.labels.set(name, color);
        sendJson(res, 201, { name, color });
        return true;
      }

      // Issues
      if (rest.length >= 1 && rest[0] === 'issues') {
        // POST /issues/{n}/comments + GET /issues/{n}/comments
        if (rest.length === 3 && rest[2] === 'comments') {
          const n = Number.parseInt(rest[1] as string, 10);
          const issue = repo.issues.find((i) => i.number === n);
          if (issue === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (method === 'POST') {
            const cbody = typeof b.body === 'string' ? b.body : '';
            const id = repo.nextComment;
            repo.nextComment += 1;
            issue.comments.push({ id, body: cbody, seq: id });
            sendJson(res, 201, { id, body: cbody, created_at: nowIso(), updated_at: nowIso() });
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: nowIso(), updated_at: nowIso() })));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        // GET /issues/{n} + PATCH /issues/{n}
        if (rest.length === 2) {
          const n = Number.parseInt(rest[1] as string, 10);
          const issue = repo.issues.find((i) => i.number === n);
          if (issue === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (method === 'GET') {
            sendJson(res, 200, issueJson(issue));
            return true;
          }
          if (method === 'PATCH') {
            if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
            sendJson(res, 200, issueJson(issue));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        // POST /issues + GET /issues
        if (rest.length === 1) {
          if (method === 'POST') {
            const title = typeof b.title === 'string' ? b.title : '';
            const ibody = typeof b.body === 'string' ? b.body : '';
            const labelNames: string[] = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
            for (const name of labelNames) {
              if (!repo.labels.has(name)) {
                jsonError(res, 422, `Unknown label: ${name}`);
                return true;
              }
            }
            const number = repo.nextIssue;
            repo.nextIssue += 1;
            const issue: Issue = { number, title, body: ibody, state: 'open', labels: [...labelNames], seq: number, comments: [] };
            repo.issues.push(issue);
            sendJson(res, 201, issueJson(issue));
            return true;
          }
          if (method === 'GET') {
            let list = [...repo.issues];
            const state = q.get('state');
            if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
            else if (state === null) list = list.filter((i) => i.state === 'open');
            if (q.get('sort') === 'created') {
              list.sort((a, c) => (q.get('direction') === 'desc' ? c.seq - a.seq : a.seq - c.seq));
            }
            const { page } = paginate(list, q);
            sendJson(res, 200, page.map((i) => issueJson(i)));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // Pull requests
      if (rest.length >= 1 && rest[0] === 'pulls') {
        // GET /pulls/{n}/files
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const n = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.find((p) => p.number === n);
          if (pull === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          const baseFlat = flatFilesAt(repo, pull.baseSha === '' ? undefined : pull.baseSha);
          const headFlat = flatFilesAt(repo, pull.headSha === '' ? undefined : pull.headSha);
          const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
          const out: JsonObj[] = [];
          for (const path of [...paths].sort()) {
            const baseEntry = baseFlat.get(path);
            const headEntry = headFlat.get(path);
            if (baseEntry !== undefined && headEntry === undefined) {
              const oldText = repo.objects.get(baseEntry.oid)?.data.toString('utf8') ?? '';
              const { deletions } = lineDiff(oldText, '');
              out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
            } else if (baseEntry === undefined && headEntry !== undefined) {
              const newText = repo.objects.get(headEntry.oid)?.data.toString('utf8') ?? '';
              const lines = newText === '' ? 0 : newText.split('\n').length;
              out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
            } else if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid !== headEntry.oid) {
              const oldText = repo.objects.get(baseEntry.oid)?.data.toString('utf8') ?? '';
              const newText = repo.objects.get(headEntry.oid)?.data.toString('utf8') ?? '';
              const { additions, deletions } = lineDiff(oldText, newText);
              out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
            }
          }
          sendJson(res, 200, out);
          return true;
        }
        // PUT /pulls/{n}/merge
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const n = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.find((p) => p.number === n);
          if (pull === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          if (pull.state === 'closed') {
            jsonError(res, 405, 'Pull request already merged');
            return true;
          }
          const baseTip = tipOf(repo, pull.baseRef);
          const headTip = tipOf(repo, pull.headRef);
          if (baseTip === undefined || headTip === undefined) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const baseFlat = flatFilesAt(repo, baseTip);
          const headFlat = flatFilesAt(repo, headTip);
          const baseOfMerge = mergeBase(repo.objects, headTip, baseTip);
          const ancestorFlat = baseOfMerge === null ? new Map<string, { oid: string; mode: string }>() : flatFilesAt(repo, baseOfMerge);
          // Conflict: a path changed on both sides of the merge base to different contents.
          const allPaths = new Set<string>([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
          for (const path of allPaths) {
            const anc = ancestorFlat.get(path);
            const onBase = baseFlat.get(path);
            const onHead = headFlat.get(path);
            const baseChanged = (anc?.oid ?? null) !== (onBase?.oid ?? null);
            const headChanged = (anc?.oid ?? null) !== (onHead?.oid ?? null);
            if (baseChanged && headChanged && (onBase?.oid ?? null) !== (onHead?.oid ?? null)) {
              jsonError(res, 405, 'Merge conflict');
              return true;
            }
          }
          // Squash: apply head's changes relative to the merge base onto the base tree.
          const merged = new Map<string, { oid: string; mode: string }>(baseFlat);
          for (const [path, entry] of ancestorFlat) {
            const headEntry = headFlat.get(path);
            if ((headEntry?.oid ?? null) !== (entry.oid ?? null)) {
              if (headEntry === undefined) merged.delete(path);
              else merged.set(path, headEntry);
            }
          }
          for (const [path, entry] of headFlat) {
            if (!ancestorFlat.has(path)) merged.set(path, entry);
          }
          const rootTree = buildTreeFromFlat(repo, merged);
          const message = `Squash merge PR #${pull.number}: ${pull.title}`;
          const mergeSha = makeCommit(repo, rootTree, [baseTip], message);
          repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = nowIso();
          pull.mergeCommitSha = mergeSha;
          sendJson(res, 200, { merged: true, sha: mergeSha, message });
          return true;
        }
        // GET /pulls/{n}
        if (rest.length === 2 && method === 'GET') {
          const n = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.find((p) => p.number === n);
          if (pull === undefined) { jsonError(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, pullJson(pull));
          return true;
        }
        // POST /pulls + GET /pulls
        if (rest.length === 1) {
          if (method === 'POST') {
            const head = typeof b.head === 'string' ? b.head : '';
            const base = typeof b.base === 'string' ? b.base : '';
            const title = typeof b.title === 'string' ? b.title : '';
            const ibody = typeof b.body === 'string' ? b.body : '';
            const headSha = tipOf(repo, head);
            const baseSha = tipOf(repo, base);
            if (head === '' || base === '' || headSha === undefined || baseSha === undefined) {
              jsonError(res, 422, 'Unknown head or base branch');
              return true;
            }
            const number = repo.nextPull;
            repo.nextPull += 1;
            const pull: Pull = {
              number, title, body: ibody, state: 'open', merged: false, mergedAt: '', mergeCommitSha: '',
              headRef: head, baseRef: base, headSha, baseSha, seq: number,
            };
            repo.pulls.push(pull);
            sendJson(res, 201, pullJson(pull));
            return true;
          }
          if (method === 'GET') {
            let list = [...repo.pulls];
            const state = q.get('state');
            if (state === 'all') {
              // all
            } else if (state === 'closed') {
              list = list.filter((p) => p.state === 'closed');
            } else {
              list = list.filter((p) => p.state === 'open');
            }
            const { page } = paginate(list, q);
            sendJson(res, 200, page.map((p) => pullJson(p)));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      jsonError(res, 404, 'Not Found');
      return true;
    }

    // Anything else under /api/v3: unknown route.
    jsonError(res, 404, 'Not Found');
    return true;
  } catch (err) {
    jsonError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    return true;
  }
}
