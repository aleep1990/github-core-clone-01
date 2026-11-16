// Smoke test for src/rest.ts — starts a node:http server using handleRest
// and exercises the REST v3 contract end to end.
// Run: node --experimental-strip-types \
//        tests/rest-test.mjs
process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

import { createServer } from 'node:http';
import { handleRest } from '../src/rest.ts';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

const server = createServer(async (req, res) => {
  const handled = await handleRest(req, res);
  if (!handled) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not Found' })); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function req(method, path, body, useToken = true, rawBody = null) {
  const headers = { 'content-type': 'application/json', accept: 'application/vnd.github+json' };
  if (useToken) headers.authorization = 'Bearer test-token';
  const init = { method, headers };
  if (rawBody !== null) init.body = rawBody;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, headers: res.headers, text, json };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const dec = (s) => Buffer.from(s.replace(/[\r\n\t ]/g, ''), 'base64').toString('utf8');

try {
  // --- root / meta / user ---
  let r = await req('GET', '/api/v3/');
  ok('root 200', r.status === 200, `got ${r.status}`);
  ok('root x-oauth-scopes', (r.headers.get('x-oauth-scopes') ?? '').length > 0);
  ok('root request-id', (r.headers.get('x-github-request-id') ?? '').length > 0);
  ok('root content-type json', (r.headers.get('content-type') ?? '').includes('application/json'));
  r = await req('GET', '/api/v3/meta');
  ok('meta installed_version', r.status === 200 && typeof r.json?.installed_version === 'string' && r.json.installed_version.length > 0, r.text);
  r = await req('GET', '/api/v3/user');
  ok('user adaiversen/1000', r.status === 200 && r.json?.login === 'adaiversen' && r.json?.id === 1000, r.text);

  // --- repos ---
  r = await req('POST', '/api/v3/user/repos', { name: 'rest-smoke', private: false, description: 'smoke' });
  ok('create repo 201', r.status === 201 && r.json?.name === 'rest-smoke' && r.json?.private === false && typeof r.json?.default_branch === 'string' && r.json.default_branch.length > 0, r.text);
  const mainBranch = r.json.default_branch;
  r = await req('POST', '/api/v3/user/repos', { name: 'rest-smoke', private: false });
  ok('duplicate repo 422', r.status === 422, `got ${r.status}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke');
  ok('get repo 200', r.status === 200 && r.json?.name === 'rest-smoke', r.text);
  r = await req('PATCH', '/api/v3/repos/adaiversen/rest-smoke', { description: 'updated desc' });
  ok('patch repo 200', r.status === 200 && r.json?.description === 'updated desc', r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke');
  ok('patch persists', r.json?.description === 'updated desc');
  r = await req('GET', '/api/v3/repos/olgabauer/rest-smoke');
  ok('foreign owner 404 not 403', r.status === 404, `got ${r.status}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke', undefined, false);
  ok('401 without token', r.status === 401 && typeof r.json?.message === 'string' && r.json.message.length > 0 && (r.headers.get('x-github-request-id') ?? '').length > 0, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/no-such-repo');
  ok('missing repo 404', r.status === 404);
  r = await req('GET', '/api/v3/no-such-route/xyz');
  ok('unknown route 404 json', r.status === 404 && typeof r.json?.message === 'string' && (r.headers.get('content-type') ?? '').includes('application/json'), r.text);
  r = await req('POST', '/api/v3/user/repos', undefined, true, '{"name":');
  ok('malformed JSON 400', r.status === 400 && typeof r.json?.message === 'string', `got ${r.status} ${r.text}`);

  // --- labels / issues ---
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/labels', { name: 'bug', color: 'ededed' });
  ok('create label 201', r.status === 201 && r.json?.name === 'bug', r.text);
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/issues', { title: 'bad', body: 'x', labels: ['nope'] });
  ok('unknown label 422', r.status === 422, `got ${r.status}`);
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/issues', { title: 'first issue', body: 'body one', labels: ['bug'] });
  ok('create issue 201 #1', r.status === 201 && r.json?.number === 1 && r.json?.state === 'open' && r.json?.labels?.[0]?.name === 'bug', r.text);
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/issues', { title: 'second issue', body: 'body two' });
  ok('create issue #2', r.status === 201 && r.json?.number === 2, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/issues?state=open&sort=created&direction=asc&per_page=100');
  ok('list issues asc', r.status === 200 && Array.isArray(r.json) && r.json.length === 2 && r.json[0].number === 1 && r.json[1].number === 2, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/issues?sort=created&direction=desc&per_page=100');
  ok('list issues desc', r.status === 200 && r.json[0].number === 2 && r.json[1].number === 1, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/issues/1');
  ok('get issue 1', r.status === 200 && r.json?.title === 'first issue' && r.json?.body === 'body one', r.text);
  r = await req('PATCH', '/api/v3/repos/adaiversen/rest-smoke/issues/1', { state: 'closed' });
  ok('close issue 200', r.status === 200 && r.json?.state === 'closed', r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/issues?state=open&per_page=100');
  ok('state=open omits closed', r.status === 200 && r.json.length === 1 && r.json[0].number === 2, r.text);
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/issues/2/comments', { body: 'hello comment' });
  ok('post comment 201', r.status === 201 && typeof r.json?.id === 'number' && r.json.id >= 1 && r.json?.body === 'hello comment', r.text);
  const commentId = r.json.id;
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/issues/2/comments');
  ok('list comments', r.status === 200 && r.json.some((c) => c.id === commentId && c.body === 'hello comment'), r.text);

  // --- contents: create on unborn repo ---
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/README.md', { message: 'add readme', content: b64('hello readme\n') });
  ok('PUT contents create 201', r.status === 201 && typeof r.json?.content?.sha === 'string' && /^[0-9a-f]{40}$/i.test(r.json.content.sha) && r.json.content.encoding === 'base64' && /^[0-9a-f]{40}$/i.test(r.json?.commit?.sha ?? ''), r.text);
  const blobSha1 = r.json.content.sha;
  const commitSha1 = r.json.commit.sha;
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/README.md');
  ok('GET contents file', r.status === 200 && r.json?.type === 'file' && r.json?.sha === blobSha1 && r.json?.size === Buffer.byteLength('hello readme\n', 'utf8') && dec(r.json.content) === 'hello readme\n', r.text);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/README.md', { message: 'update readme', content: b64('hello readme v2\n'), sha: blobSha1 });
  ok('PUT contents update 200', (r.status === 200 || r.status === 201) && r.json?.content?.sha !== blobSha1, `got ${r.status} ${r.text}`);
  const blobSha2 = r.json.content.sha;
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/README.md', { message: 'stale', content: b64('stale\n'), sha: blobSha1 });
  ok('stale sha 409', r.status === 409, `got ${r.status}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/');
  ok('GET directory root', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'README.md' && e.type === 'file'), r.text);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/docs/a.txt', { message: 'add doc', content: b64('doc a\n') });
  ok('PUT nested file 201', r.status === 201, `got ${r.status} ${r.text}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/docs');
  ok('GET directory docs', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'a.txt'), r.text);
  const docGet = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/docs/a.txt');
  r = await req('DELETE', '/api/v3/repos/adaiversen/rest-smoke/contents/docs/a.txt', { message: 'remove doc', sha: docGet.json.sha });
  ok('DELETE contents 200', r.status === 200 && /^[0-9a-f]{40}$/i.test(r.json?.commit?.sha ?? ''), `got ${r.status} ${r.text}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/docs/a.txt');
  ok('GET deleted file 404', r.status === 404, `got ${r.status}`);

  // --- branches / commits ---
  const mainTip = (await req('GET', `/api/v3/repos/adaiversen/rest-smoke/commits`)).json?.[0]?.sha;
  ok('main tip exists', typeof mainTip === 'string' && /^[0-9a-f]{40}$/i.test(mainTip), String(mainTip));
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/git/refs', { ref: 'refs/heads/feature', sha: mainTip });
  ok('create branch 201', r.status === 201 && r.json?.ref === 'refs/heads/feature' && r.json?.object?.sha === mainTip, r.text);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/feat.txt', { message: 'feat commit', content: b64('feature work\n'), branch: 'feature' });
  ok('PUT on feature branch', r.status === 201, `got ${r.status} ${r.text}`);
  const featCommit = r.json.commit.sha;
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/branches');
  ok('list branches incl feature+main', r.status === 200 && r.json.some((x) => x.name === 'feature' && x.commit.sha === featCommit) && r.json.some((x) => x.name === mainBranch), r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/commits?sha=feature');
  ok('commits?sha=feature has feat msg', r.status === 200 && r.json.some((c) => c.commit.message === 'feat commit'), r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/commits');
  ok('default commits exclude feature-only', r.status === 200 && !r.json.some((c) => c.commit.message === 'feat commit'), r.text);

  // --- pulls: squash merge ---
  r = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/pulls', { head: 'feature', base: mainBranch, title: 'add feat', body: 'pr body' });
  ok('create PR 201', r.status === 201 && r.json?.number === 1 && r.json?.state === 'open' && r.json?.head?.ref === 'feature' && r.json?.base?.ref === mainBranch && /^[0-9a-f]{40}$/i.test(r.json.head.sha) && /^[0-9a-f]{40}$/i.test(r.json.base.sha), r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls?per_page=100');
  ok('list pulls open-only', r.status === 200 && r.json.length === 1, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls/1/files');
  ok('PR files added feat.txt', r.status === 200 && r.json.some((f) => f.filename === 'feat.txt' && (f.status === 'added' || f.status === 'changed') && f.additions >= 1 && typeof f.deletions === 'number' && typeof f.changes === 'number'), r.text);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/pulls/1/merge', { merge_method: 'squash' });
  ok('squash merge 200', r.status === 200 && r.json?.merged === true && /^[0-9a-f]{40}$/i.test(r.json?.sha ?? ''), `got ${r.status} ${r.text}`);
  const mergeSha = r.json.sha;
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls/1');
  ok('PR post-merge closed/merged', r.status === 200 && r.json?.state === 'closed' && r.json?.merged === true && typeof r.json?.merged_at === 'string' && r.json.merged_at.length > 0 && r.json?.merge_commit_sha === mergeSha, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls?per_page=100');
  ok('merged PR absent from open list', r.status === 200 && r.json.length === 0, r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls?state=all&per_page=100');
  ok('state=all includes merged', r.status === 200 && r.json.length === 1, r.text);
  r = await req('GET', `/api/v3/repos/adaiversen/rest-smoke/commits?sha=${mainBranch}`);
  ok('merge commit in base commits', r.status === 200 && r.json.some((c) => c.sha === mergeSha), r.text);
  r = await req('GET', `/api/v3/repos/adaiversen/rest-smoke/contents/feat.txt?ref=${mainBranch}`);
  ok('squashed content readable on base', r.status === 200 && dec(r.json.content) === 'feature work\n', r.text);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke/pulls/999999999');
  ok('unknown PR 404', r.status === 404, `got ${r.status}`);

  // --- merge conflict: two branches edit same file differently ---
  await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/conflict.txt', { message: 'add conflict file', content: b64('base version\n') });
  const baseTip = (await req('GET', '/api/v3/repos/adaiversen/rest-smoke/commits')).json?.[0]?.sha;
  await req('POST', '/api/v3/repos/adaiversen/rest-smoke/git/refs', { ref: 'refs/heads/c1', sha: baseTip });
  await req('POST', '/api/v3/repos/adaiversen/rest-smoke/git/refs', { ref: 'refs/heads/c2', sha: baseTip });
  await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/conflict.txt', { message: 'c1 edit', content: b64('c1 version\n'), branch: 'c1', sha: (await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/conflict.txt?ref=c1')).json.sha });
  await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/contents/conflict.txt', { message: 'c2 edit', content: b64('c2 version\n'), branch: 'c2', sha: (await req('GET', '/api/v3/repos/adaiversen/rest-smoke/contents/conflict.txt?ref=c2')).json.sha });
  const pr1 = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/pulls', { head: 'c1', base: mainBranch, title: 'c1 pr', body: '' });
  const pr2 = await req('POST', '/api/v3/repos/adaiversen/rest-smoke/pulls', { head: 'c2', base: mainBranch, title: 'c2 pr', body: '' });
  ok('conflict PRs created #2/#3', pr1.json?.number === 2 && pr2.json?.number === 3, `${pr1.text} ${pr2.text}`);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/pulls/2/merge', { merge_method: 'squash' });
  ok('merge first conflicting PR 200', r.status === 200 && r.json?.merged === true, `got ${r.status} ${r.text}`);
  r = await req('PUT', '/api/v3/repos/adaiversen/rest-smoke/pulls/3/merge', { merge_method: 'squash' });
  ok('merge second conflicting PR 405', r.status === 405 && typeof r.json?.message === 'string', `got ${r.status} ${r.text}`);

  // --- pagination: 30 fresh repos, walk Link ---
  for (let i = 0; i < 30; i++) {
    const name = `page-${String(i).padStart(2, '0')}`;
    const cr = await req('POST', '/api/v3/user/repos', { name, private: false });
    if (cr.status !== 201) { ok(`create ${name}`, false, `got ${cr.status} ${cr.text}`); }
  }
  const seen = new Set();
  let pages = 0;
  let nextUrl = `${base}/api/v3/user/repos?per_page=10`;
  let pageSizeOk = true;
  while (nextUrl && pages < 20) {
    const res = await fetch(nextUrl, { headers: { authorization: 'Bearer test-token' } });
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length > 10) pageSizeOk = false;
    for (const repo of arr) {
      if (seen.has(repo.name)) pageSizeOk = false;
      seen.add(repo.name);
    }
    pages++;
    const link = res.headers.get('link') ?? '';
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    nextUrl = m ? m[1] : null;
    if (nextUrl && !nextUrl.startsWith(base)) { ok('next URL same-origin', false, nextUrl); nextUrl = null; }
  }
  ok('pagination >=3 pages, 30+ repos, no repeats, <=10/page', pages >= 3 && seen.size >= 30 && pageSizeOk, `pages=${pages} seen=${seen.size} sizeOk=${pageSizeOk}`);

  // --- delete repo ---
  r = await req('DELETE', '/api/v3/repos/adaiversen/rest-smoke');
  ok('delete repo 204', r.status === 204, `got ${r.status}`);
  r = await req('GET', '/api/v3/repos/adaiversen/rest-smoke');
  ok('get deleted repo 404', r.status === 404, `got ${r.status}`);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
