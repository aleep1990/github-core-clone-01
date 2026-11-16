// Smoke test for src/mcp.ts — exercises all 15 contract checks from
// contract/04-graphql-mcp-bench.md section 2, plus notifications/initialized
// and DELETE close as extras. A minimal REST shim (GET repo / issues list /
// pull) reads the SAME store, so rest-parity is verified over HTTP.
//
// Run: MAKEFUN_SHOP_TOKEN=test-token \
//   node --experimental-strip-types \
//   tests/mcp-test.mjs

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';
process.env.MAKEFUN_TRIAL_NOW = '2026-11-14T06:30:00.000Z';

const { createServer } = await import('node:http');
const { handleMcp, repoView, issueView, pullView } = await import(
  '../src/mcp.ts'
);
const { store } = await import(
  '../src/store.ts'
);

const TOKEN = 'test-token';
const OWNER = 'adaiversen';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Minimal REST shim over the same store (shapes mirror contract/03-rest.md).
const server = createServer(async (req, res) => {
  if (await handleMcp(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://entry');
  const seg = url.pathname.split('/').filter(Boolean);
  const send = (status, body) => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user' && seg.length === 3) {
    send(200, { login: OWNER, id: 1000 });
    return;
  }
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length === 5) {
    const repo = store.getRepo(seg[3], seg[4]);
    if (!repo) return send(404, { message: 'Not Found' });
    return send(200, repoView(repo));
  }
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length === 6 && seg[5] === 'issues') {
    const repo = store.getRepo(seg[3], seg[4]);
    if (!repo) return send(404, { message: 'Not Found' });
    return send(200, repo.issues.map((i) => issueView(seg[3], seg[4], i)));
  }
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length === 7 && seg[5] === 'pulls') {
    const repo = store.getRepo(seg[3], seg[4]);
    if (!repo) return send(404, { message: 'Not Found' });
    const pull = repo.pulls.find((p) => p.number === Number(seg[6]));
    if (!pull) return send(404, { message: 'Not Found' });
    return send(200, pullView(seg[3], seg[4], pull));
  }
  send(404, { message: 'Not Found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let rpcId = 0;
async function rpc(method, params = {}, extra = {}) {
  const id = ++rpcId;
  const body = { jsonrpc: '2.0', id, method, params, ...extra };
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
      ...extra.headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: res.status, json, text };
}
async function rpcRaw(body, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}
async function rpcNoAuth(method, params = {}) {
  const id = ++rpcId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, text: await res.text() };
}
async function callTool(name, args, idOverride) {
  const id = idOverride ?? ++rpcId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* leave null */ }
  return { status: res.status, json, text };
}

const REPO = 'mcp-smoke-repo';
const REPO2 = 'mcp-smoke-repo-2';

// 1. initialize (legacy era 2025-11-25)
{
  const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  const ok =
    r.status === 200 &&
    r.json?.result?.serverInfo?.name?.length > 0 &&
    r.json?.result?.serverInfo?.version?.length > 0 &&
    r.json?.result?.capabilities?.tools !== undefined &&
    r.json?.result?.protocolVersion === '2025-11-25';
  check('initialize', ok, JSON.stringify(r.json)?.slice(0, 300));
  // notifications/initialized is a notification: 202, no JSON-RPC body.
  const nres = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const ntext = await nres.text();
  check('notifications/initialized (extra)', nres.status === 202 && ntext === '', `status=${nres.status} body=${JSON.stringify(ntext)}`);
}

// 2. server-discover (modern era)
{
  const r = await rpc('server/discover', {}, {
    _meta: undefined,
  });
  // send _meta properly: rpc() above drops _meta; do a dedicated call
  const id = ++rpcId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          protocolVersion: '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'makefun-github-core-clone-env', version: '1.0.0' },
        },
      },
    }),
  });
  const json = await res.json();
  const versions = json?.result?.supportedVersions;
  const ok =
    res.status === 200 &&
    Array.isArray(versions) &&
    versions.length > 0 &&
    versions.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) &&
    versions.includes('2026-07-28');
  check('server-discover', ok, JSON.stringify(json)?.slice(0, 300));
  void r;
}

// 3. tools-list: >=6 tools incl. the six required names
let toolsListJson = null;
{
  const r = await rpc('tools/list', {});
  toolsListJson = r.json;
  const tools = r.json?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  const required = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  check('tools-list', tools.length >= 6 && required.every((n) => names.includes(n)), `tools=${names.join(',')}`);
  // 4. tool-schemas
  const ok = tools.every((t) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema?.type === 'object');
  check('tool-schemas', ok);
}

// 5. create-issue (via tools/call) then REST-list it
let issueNumber = null;
let createdRepoId = null;
{
  const rc = await callTool('create_repo', { name: REPO, description: 'smoke repo', private: false });
  const repoObj = JSON.parse(rc.json?.result?.content?.[0]?.text ?? '{}');
  createdRepoId = repoObj.id;
  check('create_repo setup', rc.status === 200 && repoObj.name === REPO && typeof createdRepoId === 'number', rc.text.slice(0, 200));
  const ci = await callTool('create_issue', { owner: OWNER, repo: REPO, title: 'smoke issue title', body: 'smoke body' });
  const issueObj = JSON.parse(ci.json?.result?.content?.[0]?.text ?? '{}');
  issueNumber = issueObj.number;
  const rest = await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}/issues`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const listed = await rest.json();
  check('create-issue', ci.json?.result?.isError !== true && listed.some((i) => i.title === 'smoke issue title'), `issue=${JSON.stringify(issueObj)} listed=${JSON.stringify(listed).slice(0, 200)}`);
}

// 6. list-issues
{
  const li = await callTool('list_issues', { owner: OWNER, repo: REPO });
  const text = li.json?.result?.content?.map((c) => c.text).join('') ?? '';
  check('list-issues', text.includes('smoke issue title') || text.includes(`"number": ${issueNumber}`), text.slice(0, 200));
}

// 7. create-pull-request, REST reads same head/base
let prNumber = null;
{
  const cp = await callTool('create_pull_request', { owner: OWNER, repo: REPO, title: 'smoke pr', head: 'feature', base: 'main', body: 'pr body' });
  const prObj = JSON.parse(cp.json?.result?.content?.[0]?.text ?? '{}');
  prNumber = prObj.number;
  const rest = await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}/pulls/${prNumber}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const back = await rest.json();
  check('create-pull-request', back.head?.ref === 'feature' && back.base?.ref === 'main', `pr=${JSON.stringify(prObj)} rest=${JSON.stringify(back)}`);
}

// 8. merge-pull-request, REST reads merged:true
{
  const mp = await callTool('merge_pull_request', { owner: OWNER, repo: REPO, pull_number: prNumber });
  const rest = await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}/pulls/${prNumber}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const back = await rest.json();
  check('merge-pull-request', mp.json?.result?.isError !== true && back.merged === true && back.state === 'closed', JSON.stringify(back));
}

// 9. unknown-tool -> -32602 or -32601, never HTTP 500
{
  const u = await callTool('no_such_tool_xyz', {});
  const code = u.json?.error?.code;
  check('unknown-tool', u.status !== 500 && (code === -32602 || code === -32601), `status=${u.status} code=${code}`);
}

// 10. parse-error: non-JSON body -> HTTP 400 with -32700
{
  const p = await rpcRaw('{"name":');
  let code = null;
  try {
    code = JSON.parse(p.text)?.error?.code;
  } catch { /* ignore */ }
  check('parse-error', p.status === 400 && code === -32700, `status=${p.status} body=${p.text.slice(0, 200)}`);
}

// 11. missing-arguments: create_issue {} -> isError:true or -32602
{
  const m = await callTool('create_issue', {});
  const code = m.json?.error?.code;
  check('missing-arguments', m.json?.result?.isError === true || code === -32602, m.text.slice(0, 200));
}

// 12. concurrent-calls: two get_repo under distinct ids answer their own repos
{
  await callTool('create_repo', { name: REPO2 });
  const [a, b] = await Promise.all([
    callTool('get_repo', { owner: OWNER, repo: REPO }, 9001),
    callTool('get_repo', { owner: OWNER, repo: REPO2 }, 9002),
  ]);
  const aObj = JSON.parse(a.json?.result?.content?.[0]?.text ?? '{}');
  const bObj = JSON.parse(b.json?.result?.content?.[0]?.text ?? '{}');
  check('concurrent-calls', a.json?.id === 9001 && b.json?.id === 9002 && aObj.name === REPO && bObj.name === REPO2, `a=${a.text.slice(0, 150)} b=${b.text.slice(0, 150)}`);
}

// 13. tools-list-idempotent: byte-for-byte identical tools arrays
{
  const l1 = await rpc('tools/list', {});
  const l2 = await rpc('tools/list', {});
  check('tools-list-idempotent', JSON.stringify(l1.json?.result?.tools) === JSON.stringify(l2.json?.result?.tools));
}

// 14. rest-parity: MCP-created repo + issue are the same objects over REST, ids stable
{
  const restRepo1 = await (await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const restRepo2 = await (await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const restIssues = await (await fetch(`${base}/api/v3/repos/${OWNER}/${REPO}/issues`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const issue = restIssues.find((i) => i.number === issueNumber);
  check('rest-parity', restRepo1.id === createdRepoId && restRepo1.id === restRepo2.id && issue?.title === 'smoke issue title' && issue?.id === issueView(OWNER, REPO, store.getRepo(OWNER, REPO).issues[0]).id, `repoId=${restRepo1.id}/${createdRepoId} issue=${JSON.stringify(issue)}`);
}

// 15. auth-required: tools/call with no Authorization -> 401
{
  const a = await rpcNoAuth('tools/call', { name: 'get_repo', arguments: { owner: OWNER, repo: REPO } });
  check('auth-required', a.status === 401, `status=${a.status} body=${a.text.slice(0, 150)}`);
}

// Extra: DELETE close -> 200
{
  const d = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  check('delete-close (extra)', d.status === 200, `status=${d.status}`);
}

// Extra: unsupported version -> -32022 with data.supported
{
  const id = ++rpcId;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2999-01-01' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2999-01-01' } } }),
  });
  const json = await res.json();
  check('unsupported-version -32022 (extra)', json?.error?.code === -32022 && Array.isArray(json?.error?.data?.supported), JSON.stringify(json).slice(0, 200));
}

server.close();
console.log(`\n${passed} passed, ${failed} failed${failed ? ` — failed: ${failures.join(', ')}` : ''}`);
process.exit(failed === 0 ? 0 : 1);
