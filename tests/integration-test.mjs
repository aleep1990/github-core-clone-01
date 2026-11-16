// Integration test for the full forge (app.ts + all four surfaces, one store).
// Boots createApp() and cross-checks REST <-> git <-> GraphQL <-> MCP.
// Run: node --experimental-strip-types \
//        ~/workspace/makefun-github-clone/tests/integration-test.mjs
// NOTE: MAKEFUN_SHOP_TOKEN intentionally unset here -> any non-empty Bearer
// token is accepted (see src/http.ts). No real credentials anywhere.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../app.ts';

const execFileAsync = promisify(execFile);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

const TOKEN = 'test-token';
const app = createApp();
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const port = app.address().port;
const base = `http://127.0.0.1:${port}`;
const gitBase = `http://127.0.0.1:${port}/adaiversen/integration.git`;

async function req(method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/vnd.github+json' };
  if (opts.token !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.headers) Object.assign(headers, opts.headers);
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, headers: res.headers, text, json };
}

const work = mkdtempSync(join(tmpdir(), 'forge-integration-'));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ada iversen',
  GIT_AUTHOR_EMAIL: 'adaiversen@example.invalid',
  GIT_COMMITTER_NAME: 'ada iversen',
  GIT_COMMITTER_EMAIL: 'adaiversen@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: work,
};
async function git(args, cwd, extraEnv = {}) {
  const { stdout } = await execFileAsync('git', ['-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args],
    { cwd, env: { ...gitEnv, ...extraEnv }, encoding: 'utf8' });
  return stdout;
}

try {
  // --- boot probe + 404 shape ---
  let r = await req('GET', '/healthz', undefined, { token: false });
  ok('healthz 200 ok:true', r.status === 200 && r.json?.ok === true, r.text);
  r = await req('GET', '/nope', undefined, { token: false });
  ok('unknown path JSON 404', r.status === 404 && typeof r.json?.message === 'string', r.text);

  // --- REST: create repo ---
  r = await req('POST', '/api/v3/user/repos', { name: 'integration', private: false, description: 'integration repo' });
  ok('REST create repo 201', r.status === 201 && r.json?.name === 'integration' && r.json?.owner?.login === 'adaiversen', r.text);
  const defaultBranch = r.json?.default_branch ?? 'main';

  // --- git: empty clone, first push ---
  const clone1 = join(work, 'c1');
  await git(['clone', gitBase, clone1], work);
  ok('git empty clone ok', true);
  writeFileSync(join(clone1, 'README.md'), 'hello forge\n');
  writeFileSync(join(clone1, 'app.py'), 'x=1\n');
  await git(['add', '.'], clone1);
  await git(['commit', '-m', 'first commit'], clone1);
  await git(['push', 'origin', `HEAD:refs/heads/${defaultBranch}`], clone1);
  ok('git first push ok', true);

  // --- REST: contents read-back of the pushed commit ---
  r = await req('GET', '/api/v3/repos/adaiversen/integration/contents/README.md');
  const readme = r.json?.content ? Buffer.from(r.json.content.replace(/\s/g, ''), 'base64').toString('utf8') : '';
  ok('REST contents README matches push', r.status === 200 && readme === 'hello forge\n', r.text.slice(0, 200));

  // --- REST: issue lifecycle ---
  r = await req('POST', '/api/v3/repos/adaiversen/integration/issues', { title: 'First bug', body: 'it broke' });
  ok('REST create issue #1', r.status === 201 && r.json?.number === 1 && r.json?.title === 'First bug', r.text);
  r = await req('POST', '/api/v3/repos/adaiversen/integration/issues/1/comments', { body: 'repro confirmed' });
  ok('REST comment on issue', r.status === 201 && r.json?.body === 'repro confirmed', r.text);
  r = await req('PATCH', '/api/v3/repos/adaiversen/integration/issues/1', { state: 'closed' });
  ok('REST close issue', r.status === 200 && r.json?.state === 'closed', r.text);

  // --- GraphQL: sees the REST-created issue, creates one of its own ---
  const gql = async (query, variables) => {
    const res = await req('POST', '/api/graphql', { query, variables });
    return res;
  };
  r = await gql(`{ repository(owner: "adaiversen", name: "integration") { issues(first: 10) { nodes { number title state } } } }`);
  const gqlIssues = r.json?.data?.repository?.issues?.nodes ?? [];
  ok('GraphQL sees REST issue #1 closed', r.status === 200 && gqlIssues.some((i) => i.number === 1 && i.state === 'CLOSED'), r.text.slice(0, 300));
  const idRes = await gql(`{ repository(owner: "adaiversen", name: "integration") { id } }`);
  const gid = idRes.json?.data?.repository?.id;
  ok('GraphQL repository global id', typeof gid === 'string' && gid.length > 0, JSON.stringify(idRes.json)?.slice(0, 200));
  r = await gql(`mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title } } }`,
    { input: { repositoryId: gid, title: 'GQL issue', body: 'from graphql' } });
  ok('GraphQL createIssue', r.status === 200 && r.json?.data?.createIssue?.issue?.number === 2, r.text.slice(0, 300));
  r = await req('GET', '/api/v3/repos/adaiversen/integration/issues/2');
  ok('REST sees GraphQL issue #2', r.status === 200 && r.json?.title === 'GQL issue', r.text.slice(0, 200));

  // --- MCP: create issue via tools/call, read back via REST ---
  const mcp = async (body) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: res.status, text, json };
  };
  r = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'integration', title: 'MCP issue', body: 'from mcp' } } });
  const mcpIssueNo = r.json?.result?.content?.[0]?.text ? JSON.parse(r.json.result.content[0].text)?.number : null;
  ok('MCP create_issue', r.status === 200 && mcpIssueNo === 3, r.text.slice(0, 300));
  r = await req('GET', '/api/v3/repos/adaiversen/integration/issues/3');
  ok('REST sees MCP issue #3', r.status === 200 && r.json?.title === 'MCP issue', r.text.slice(0, 200));

  // --- git: branch push -> REST PR -> REST squash merge -> fresh clone sees it ---
  await git(['checkout', '-b', 'feature'], clone1);
  writeFileSync(join(clone1, 'app.py'), 'x=1\nfeature line\n');
  await git(['add', '.'], clone1);
  await git(['commit', '-m', 'feature work'], clone1);
  await git(['push', 'origin', 'feature'], clone1);
  ok('git branch push ok', true);
  r = await req('POST', '/api/v3/repos/adaiversen/integration/pulls', { title: 'Add feature', head: 'feature', base: defaultBranch });
  ok('REST create PR #1', r.status === 201 && r.json?.number === 1 && r.json?.head?.ref === 'feature', r.text.slice(0, 300));
  r = await req('PUT', '/api/v3/repos/adaiversen/integration/pulls/1/merge', { merge_method: 'squash' });
  ok('REST squash-merge PR', r.status === 200 && (r.json?.merged === true || r.json?.sha), r.text.slice(0, 300));
  r = await req('GET', '/api/v3/repos/adaiversen/integration/pulls/1');
  ok('REST PR shows merged', r.status === 200 && (r.json?.merged === true || r.json?.state === 'closed'), r.text.slice(0, 200));

  const clone2 = join(work, 'c2');
  await git(['clone', gitBase, clone2], work);
  const appPy = readFileSync(join(clone2, 'app.py'), 'utf8');
  ok('fresh clone sees merged feature', appPy.includes('feature line'), appPy);
  const log = await git(['log', '--oneline', defaultBranch], clone2);
  ok('fresh clone log has merge commit', log.split('\n').length >= 3, log);

  // --- determinism spot check: identical GETs, identical bodies ---
  const a = await req('GET', '/api/v3/repos/adaiversen/integration/issues?state=all');
  const b = await req('GET', '/api/v3/repos/adaiversen/integration/issues?state=all');
  ok('deterministic issue list bytes', a.text === b.text, `len ${a.text.length} vs ${b.text.length}`);
} finally {
  app.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
