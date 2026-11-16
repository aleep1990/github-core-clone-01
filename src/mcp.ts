// MCP surface (Model Context Protocol) over Streamable HTTP, hand-rolled
// JSON-RPC 2.0 with stdlib only — no @modelcontextprotocol/sdk.
//
// Two protocol eras are supported:
//   * Modern 2026-07-28: server/discover is mandatory; requests carry the
//     revision in _meta; no handshake, no session.
//   * Legacy 2025-11-25 and earlier: initialize (echo the negotiated
//     revision) then notifications/initialized; optional Mcp-Session-Id
//     echoed from any response onward; DELETE on close answers 200.
//
// Tools act on the SAME store as REST, so an MCP-created repo/issue/PR reads
// back identically over REST. Determinism: every timestamp comes from
// nowIso(); merge SHAs are sha1 hashes, never random or wall-clock.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { store, VIEWER, globalId, nowIso, type Issue, type Pull, type Repo } from './store.ts';
import { authViewer, parseJsonBody, readBody, sendJson } from './http.ts';

const SERVER_NAME = 'makefun-github-core-clone';
const SERVER_VERSION = '1.0.0';

const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS: string[] = [MODERN_REVISION, ...LEGACY_REVISIONS];

const ZERO_SHA = '0000000000000000000000000000000000000000';

/** The tools array is built ONCE at module load so tools/list is byte-for-byte identical across calls. */
const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalized-name aliases the suite may use for the six tools. */
const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

/** REST-shaped repository view (same fields REST returns). */
export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/** REST-shaped issue view. */
export function issueView(owner: string, repoName: string, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', `${owner}/${repoName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

/** REST-shaped pull request view. */
export function pullView(owner: string, repoName: string, pull: Pull): Record<string, unknown> {
  return {
    id: globalId('PullRequest', `${owner}/${repoName}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolTextResult(payload: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
  if (isError) out.isError = true;
  return out;
}

function toolError(message: string): Record<string, unknown> {
  return toolTextResult({ error: message }, true);
}

/** Accept the documented property names plus the suite's alias spellings. */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

function refSha(repo: Repo, branch: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? ZERO_SHA;
}

function mergeSha(owner: string, repoName: string, number: number): string {
  return createHash('sha1').update(`${owner}/${repoName}/pull/${number}/merge`).digest('hex');
}

/** Execute one tool call; returns a tools/call result object (isError on failure). */
function executeTool(name: string, rawArgs: unknown): Record<string, unknown> {
  const args: Record<string, unknown> =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  if (name === 'create_repo') {
    const missing = missingRequired(args, ['name']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const repoName = asString(args.name) as string;
    const description = asString(args.description) ?? '';
    const priv = args.private === true;
    if (store.getRepo(VIEWER.login, repoName) !== undefined) {
      return toolError(`repository already exists: ${VIEWER.login}/${repoName}`);
    }
    const repo = store.createRepo(VIEWER.login, repoName, description, priv);
    return toolTextResult(repoView(repo));
  }

  if (name === 'get_repo') {
    const missing = missingRequired(args, ['owner', 'repo']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const owner = asString(pick(args, 'owner', 'owner_login')) as string;
    const repoName = asString(pick(args, 'repo', 'repository', 'name')) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);
    return toolTextResult(repoView(repo));
  }

  if (name === 'create_issue') {
    const missing = missingRequired(args, ['owner', 'repo', 'title']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const owner = asString(pick(args, 'owner', 'owner_login')) as string;
    const repoName = asString(pick(args, 'repo', 'repository', 'name')) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);
    const issue: Issue = {
      number: repo.nextIssue,
      title: asString(args.title) as string,
      body: asString(args.body) ?? '',
      state: 'open',
      labels: [],
      seq: repo.nextIssue,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return toolTextResult(issueView(owner, repoName, issue));
  }

  if (name === 'list_issues') {
    const missing = missingRequired(args, ['owner', 'repo']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const owner = asString(pick(args, 'owner', 'owner_login')) as string;
    const repoName = asString(pick(args, 'repo', 'repository', 'name')) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);
    const state = asString(args.state) ?? 'all';
    const filtered = repo.issues.filter((issue) => {
      if (state === 'open') return issue.state === 'open';
      if (state === 'closed') return issue.state === 'closed';
      return true;
    });
    return toolTextResult({
      repository: `${owner}/${repoName}`,
      issues: filtered.map((issue) => issueView(owner, repoName, issue)),
    });
  }

  if (name === 'create_pull_request') {
    const missing = missingRequired(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const owner = asString(pick(args, 'owner', 'owner_login')) as string;
    const repoName = asString(pick(args, 'repo', 'repository', 'name')) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);
    const head = asString(args.head) as string;
    const base = asString(args.base) as string;
    const pull: Pull = {
      number: repo.nextPull,
      title: asString(args.title) as string,
      body: asString(args.body) ?? '',
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      headRef: head,
      baseRef: base,
      headSha: refSha(repo, head),
      baseSha: refSha(repo, base),
      seq: repo.nextPull,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return toolTextResult(pullView(owner, repoName, pull));
  }

  if (name === 'merge_pull_request') {
    const missing = missingRequired(args, ['owner', 'repo', 'pull_number']);
    if (missing !== null) return toolError(`missing required argument: ${missing}`);
    const owner = asString(pick(args, 'owner', 'owner_login')) as string;
    const repoName = asString(pick(args, 'repo', 'repository', 'name')) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);
    const number = asNumber(pick(args, 'pull_number', 'number'));
    if (number === undefined) return toolError('missing required argument: pull_number');
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return toolError(`pull request not found: ${owner}/${repoName}#${number}`);
    if (!pull.merged) {
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = mergeSha(owner, repoName, number);
    }
    return toolTextResult(pullView(owner, repoName, pull));
  }

  return toolError(`unknown tool: ${name}`);
}

function metaProtocolVersion(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const metaObj = meta as Record<string, unknown>;
  const modern = metaObj['io.modelcontextprotocol/protocolVersion'];
  if (typeof modern === 'string') return modern;
  const plain = metaObj.protocolVersion;
  if (typeof plain === 'string') return plain;
  return undefined;
}

/**
 * Handle one JSON-RPC request object. Returns the response object, or null
 * for a notification (no response is sent for notifications).
 */
function handleRpc(req: IncomingMessage, payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const msg = payload as Record<string, unknown>;
  const id: unknown = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';

  // Notifications never get a response body.
  if (method.startsWith('notifications/')) return null;

  if (method === '') {
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }

  const params = msg.params ?? {};
  const headerVersion = req.headers['mcp-protocol-version'];
  const metaVersion = metaProtocolVersion(params);

  // Header / _meta mismatch: the header names a different revision than the body.
  if (
    typeof headerVersion === 'string' &&
    metaVersion !== undefined &&
    headerVersion !== metaVersion
  ) {
    return rpcError(id, -32020, 'Header mismatch: MCP-Protocol-Version does not match _meta protocolVersion', {
      supported: SUPPORTED_VERSIONS,
    });
  }
  // A declared revision the server does not support.
  const declared = metaVersion ?? (typeof headerVersion === 'string' ? headerVersion : undefined);
  if (declared !== undefined && !SUPPORTED_VERSIONS.includes(declared)) {
    return rpcError(id, -32022, `Unsupported protocol version: ${declared}`, {
      supported: SUPPORTED_VERSIONS,
    });
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: MODERN_REVISION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }

  if (method === 'initialize') {
    const paramsObj = params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const requested =
      typeof paramsObj.protocolVersion === 'string' ? paramsObj.protocolVersion : metaVersion;
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      return rpcError(id, -32022, `Unsupported protocol version: ${requested}`, {
        supported: SUPPORTED_VERSIONS,
      });
    }
    const negotiated = requested ?? MODERN_REVISION;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const paramsObj = params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const rawName = paramsObj.name;
    if (typeof rawName !== 'string' || rawName === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    }
    const canonical = TOOL_ALIASES[rawName] ?? rawName;
    const known = TOOLS.some((tool) => tool.name === canonical);
    if (!known) {
      return rpcError(id, -32602, `Unknown tool: ${rawName}`);
    }
    const result = executeTool(canonical, paramsObj.arguments ?? {});
    return rpcResult(id, result);
  }

  // ping is a cheap liveness method; everything else is not found.
  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * MCP endpoint handler. Returns true when the request targeted /mcp
 * (and was answered here), false otherwise so the caller can route it
 * to another surface.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  const method = req.method ?? 'GET';

  // Legacy close: DELETE answers 200.
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Parse first: a malformed body is HTTP 400 / -32700 even without a token.
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  let payload: unknown;
  try {
    payload = parseJsonBody(raw);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  // tools/call (and every other MCP call) requires the Bearer token.
  if (authViewer(req) === null) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  // Echo a session id the client is already carrying, from this response onward.
  const sessionId = req.headers['mcp-session-id'];
  const extraHeaders: Record<string, string> =
    typeof sessionId === 'string' && sessionId !== '' ? { 'mcp-session-id': sessionId } : {};

  if (Array.isArray(payload)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of payload) {
      const response = handleRpc(req, item);
      if (response !== null) responses.push(response);
    }
    sendJson(res, 200, responses, extraHeaders);
    return true;
  }

  const response = handleRpc(req, payload);
  if (response === null) {
    // Notification (e.g. notifications/initialized): no response body.
    res.writeHead(202, extraHeaders);
    res.end();
    return true;
  }
  sendJson(res, 200, response, extraHeaders);
  return true;
}
