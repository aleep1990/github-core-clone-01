// Smoke test for src/graphql.ts — exercises all 20 contract checks.
// Run: node --experimental-strip-types tests/graphql-test.mjs

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';

const { createServer } = await import('node:http');
const { handleGraphql } = await import('../src/graphql.ts');
const { store, VIEWER, globalId } = await import('../src/store.ts');
const { buildCommit, buildTree, objectId } = await import('../src/gitobj.ts');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    failures.push(name);
    console.log('FAIL', name, extra);
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- seed through the store directly (same store the handler reads) ---
const IDENT = 'ada iversen <adaiversen@example.invalid> 1735689600 +0000';
function seedIssue(repo, number, title, body, state) {
  repo.issues.push({ number, title, body, state, labels: [], seq: number, comments: [] });
}
const repo = store.createRepo(VIEWER.login, 'scenario-graphql', '', false);
seedIssue(repo, 1, 'First issue', 'body one', 'open');
seedIssue(repo, 2, 'Second issue', 'body two', 'open');
seedIssue(repo, 3, 'Third issue', 'body three', 'open');
seedIssue(repo, 4, 'Closed issue', 'body four', 'closed');
repo.nextIssue = 5;

// git objects for the PR: base commit (hello.txt), head commit (+ feature.txt)
const blobHello = Buffer.from('hello\n');
const blobHelloId = objectId('blob', blobHello);
const treeBase = buildTree([{ mode: '100644', name: 'hello.txt', oid: blobHelloId }]);
const treeBaseId = objectId('tree', treeBase);
const commitBase = buildCommit({ tree: treeBaseId, parents: [], author: IDENT, committer: IDENT, message: 'init\n' });
const cBase = objectId('commit', commitBase);
const blobFeat = Buffer.from('feature\n');
const blobFeatId = objectId('blob', blobFeat);
const treeHead = buildTree([
  { mode: '100644', name: 'hello.txt', oid: blobHelloId },
  { mode: '100644', name: 'feature.txt', oid: blobFeatId },
]);
const treeHeadId = objectId('tree', treeHead);
const commitHead = buildCommit({ tree: treeHeadId, parents: [cBase], author: IDENT, committer: IDENT, message: 'add feature\n' });
const cHead = objectId('commit', commitHead);
for (const [oid, type, data] of [
  [blobHelloId, 'blob', blobHello],
  [treeBaseId, 'tree', treeBase],
  [cBase, 'commit', commitBase],
  [blobFeatId, 'blob', blobFeat],
  [treeHeadId, 'tree', treeHead],
  [cHead, 'commit', commitHead],
]) {
  repo.objects.set(oid, { type, data });
}
repo.refs.set('refs/heads/main', cBase);
repo.refs.set('refs/heads/feature', cHead);
repo.pulls.push({
  number: 1, title: 'Add feature', body: '', state: 'open', merged: false,
  mergedAt: '', mergeCommitSha: '', headRef: 'feature', baseRef: 'main',
  headSha: cHead, baseSha: cBase, seq: 1,
});
repo.nextPull = 2;

// pagination repo: 7 open issues
const pagesRepo = store.createRepo(VIEWER.login, 'scenario-graphql-pages', '', false);
for (let n = 1; n <= 7; n += 1) seedIssue(pagesRepo, n, `Page issue ${n}`, `body ${n}`, 'open');
pagesRepo.nextIssue = 8;

const repoGid = globalId('Repository', String(repo.id));
const owner = VIEWER.login;
const repoName = repo.name;

const server = createServer((req, res) => {
  void handleGraphql(req, res).then((handled) => {
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    }
  });
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function gql(query, variables = {}, withToken = true) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (withToken) headers.authorization = 'Bearer test-token';
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function gqlRaw(rawBody, withToken = true) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (withToken) headers.authorization = 'Bearer test-token';
  const res = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rawBody),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// --- check 1: viewer login ---
{
  const { status, body } = await gql('query ViewerLogin { viewer { login } }');
  ok('1 viewer-login', status === 200 && body.data?.viewer?.login === VIEWER.login, JSON.stringify(body));
}

// --- check 2: repository fields ---
let repoIdFirst = '';
{
  const { status, body } = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
    { owner, name: repoName },
  );
  const r = body.data?.repository;
  repoIdFirst = r?.id ?? '';
  ok(
    '2 repository-fields',
    status === 200 && r?.databaseId === repo.id && r?.name === repoName && r?.owner?.login === owner &&
      r?.defaultBranchRef?.name === 'main' && ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(r?.viewerPermission) &&
      r?.hasIssuesEnabled === true && typeof r?.id === 'string' && r.id.length > 0,
    JSON.stringify(body),
  );
}

// --- check 3: introspection Issue ---
{
  const { status, body } = await gql(
    'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }',
  );
  const names = (body.data?.Issue?.fields ?? []).map((f) => f.name);
  ok('3 introspection-issue', status === 200 && ['id', 'number', 'title', 'state', 'body'].every((n) => names.includes(n)), JSON.stringify(body));
}

// --- check 4: introspection PR + Repository + SearchType ---
{
  const { status, body } = await gql(
    'query PullRequestAndRepositoryFields { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }',
  );
  const prNames = (body.data?.PullRequest?.fields ?? []).map((f) => f.name);
  const repoNames = (body.data?.Repository?.fields ?? []).map((f) => f.name);
  const { body: body2 } = await gql(
    'query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }',
  );
  const enumNames = (body2.data?.SearchType?.enumValues ?? []).map((f) => f.name);
  ok(
    '4 introspection-types',
    status === 200 &&
      ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((n) => prNames.includes(n)) &&
      ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((n) => repoNames.includes(n)) &&
      enumNames.includes('ISSUE'),
    JSON.stringify(body) + ' / ' + JSON.stringify(body2),
  );
}

// --- check 5: open issues order (run BEFORE create-issue adds a 4th open issue) ---
{
  const { status, body } = await gql(
    'query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }',
    { owner, name: repoName, first: 10 },
  );
  const nodes = body.data?.repository?.issues?.nodes ?? [];
  const numbers = nodes.map((n) => n.number);
  const strictlyDesc = numbers.every((n, i) => i === 0 || n < numbers[i - 1]);
  ok(
    '5 issues-open-order',
    status === 200 && nodes.length === 3 && nodes.every((n) => n.state === 'OPEN') && strictlyDesc &&
      eq([...numbers].sort((a, b) => a - b), [1, 2, 3]) && !numbers.includes(4) &&
      nodes.every((n) => typeof n.id === 'string' && n.id.length > 0),
    JSON.stringify(body),
  );
}

// --- check 6: issue by number ---
let issueIdFirst = '';
{
  const { status, body } = await gql(
    'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }',
    { owner, name: repoName, number: 1 },
  );
  const iss = body.data?.repository?.issue;
  issueIdFirst = iss?.id ?? '';
  ok(
    '6 issue-by-number',
    status === 200 && iss?.number === 1 && iss?.title === 'First issue' && iss?.body === 'body one' &&
      iss?.state === 'OPEN' && typeof iss?.id === 'string' && iss.id.length > 0,
    JSON.stringify(body),
  );
}

// --- check 19 (first half): global-id stability, run before mutations change ids ---
{
  const q = 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }';
  const a = await gql(q, { owner, name: repoName });
  const b = await gql(q, { owner, name: repoName });
  const q2 = 'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }';
  const c = await gql(q2, { owner, name: repoName, number: 1 });
  const d = await gql(q2, { owner, name: repoName, number: 1 });
  const repoId = a.body.data?.repository?.id;
  const issueId = c.body.data?.repository?.issue?.id;
  ok(
    '19 global-id-stability',
    repoId === b.body.data?.repository?.id && repoId === repoIdFirst && repoId !== String(repo.id) &&
      issueId === d.body.data?.repository?.issue?.id && issueId === issueIdFirst && issueId !== '1' &&
      typeof repoId === 'string' && repoId.length > 0 && typeof issueId === 'string' && issueId.length > 0,
    JSON.stringify(a.body) + ' / ' + JSON.stringify(c.body),
  );
}

// --- check 20: pagination (5 + 2, distinct, cursors) ---
{
  const q = 'query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }';
  const p1 = await gql(q, { owner, name: pagesRepo.name, first: 5, after: null });
  const conn1 = p1.body.data?.repository?.issues;
  const p2 = await gql(q, { owner, name: pagesRepo.name, first: 5, after: conn1?.pageInfo?.endCursor ?? null });
  const conn2 = p2.body.data?.repository?.issues;
  const all = [...(conn1?.nodes ?? []), ...(conn2?.nodes ?? [])].map((n) => n.number);
  ok(
    '20 issues-pagination',
    p1.status === 200 && (conn1?.nodes?.length ?? 0) === 5 && conn1?.pageInfo?.hasNextPage === true &&
      typeof conn1?.pageInfo?.endCursor === 'string' && conn1.pageInfo.endCursor.length > 0 &&
      (conn2?.nodes?.length ?? 0) === 2 && conn2?.pageInfo?.hasNextPage === false &&
      new Set(all).size === 7 && eq([...all].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]),
    JSON.stringify(p1.body) + ' / ' + JSON.stringify(p2.body),
  );
}

// --- check 17: unknown repository -> null, NO errors ---
{
  const { status, body } = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name } }',
    { owner, name: 'scenario-graphql-missing' },
  );
  ok(
    '17 unknown-repository',
    status === 200 && body.data?.repository === null && (body.errors === undefined || body.errors.length === 0),
    JSON.stringify(body),
  );
}

// --- check 16: node(id) on Repository ---
{
  const { status, body } = await gql(
    'query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }',
    { id: repoGid },
  );
  const n = body.data?.node;
  ok(
    '16 node-repository',
    status === 200 && n?.id === repoGid && n?.name === repoName && n?.nameWithOwner === `${owner}/${repoName}`,
    JSON.stringify(body),
  );
}

// --- check 9: PR list ---
{
  const { status, body } = await gql(
    'query PullRequests($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }',
    { owner, name: repoName, first: 10 },
  );
  const nodes = body.data?.repository?.pullRequests?.nodes ?? [];
  const pr = nodes.find((p) => p.number === 1);
  ok(
    '9 pull-requests-list',
    status === 200 && pr?.headRefName === 'feature' && pr?.baseRefName === 'main' && pr?.state === 'OPEN' &&
      ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr?.mergeable),
    JSON.stringify(body),
  );
}

// --- check 10: PR files ---
{
  const { status, body } = await gql(
    'query PullRequestFiles($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }',
    { owner, name: repoName, number: 1 },
  );
  const paths = (body.data?.repository?.pullRequest?.files?.nodes ?? []).map((f) => f.path);
  ok('10 pull-request-files', status === 200 && paths.includes('feature.txt'), JSON.stringify(body));
}

// --- check 7: create issue (store must read it back as open) ---
let createdIssueNumber = 0;
let createdIssueGid = '';
{
  const { status, body } = await gql(
    'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
    { input: { repositoryId: repoGid, title: 'Created via GraphQL', body: 'gql body' } },
  );
  const iss = body.data?.createIssue?.issue;
  createdIssueNumber = iss?.number ?? 0;
  createdIssueGid = iss?.id ?? '';
  const stored = repo.issues.find((i) => i.number === createdIssueNumber);
  ok(
    '7 create-issue',
    status === 200 && createdIssueNumber > 0 && typeof iss?.id === 'string' && iss.id.length > 0 &&
      stored !== undefined && stored.state === 'open' && stored.title === 'Created via GraphQL',
    JSON.stringify(body),
  );
}

// --- check 8: close issue (store must read it back as closed) ---
{
  const { status, body } = await gql(
    'mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }',
    { input: { issueId: createdIssueGid } },
  );
  const iss = body.data?.closeIssue?.issue;
  const stored = repo.issues.find((i) => i.number === createdIssueNumber);
  ok(
    '8 close-issue',
    status === 200 && iss?.number === createdIssueNumber && iss?.state === 'CLOSED' && stored?.state === 'closed',
    JSON.stringify(body),
  );
}

// --- check 11: create PR ---
let createdPrNumber = 0;
let createdPrGid = '';
{
  const { status, body } = await gql(
    'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }',
    { input: { repositoryId: repoGid, baseRefName: 'main', headRefName: 'feature', title: 'Second PR' } },
  );
  const pr = body.data?.createPullRequest?.pullRequest;
  createdPrNumber = pr?.number ?? 0;
  createdPrGid = pr?.id ?? '';
  const stored = repo.pulls.find((p) => p.number === createdPrNumber);
  ok(
    '11 create-pull-request',
    status === 200 && pr?.state === 'OPEN' && pr?.headRefName === 'feature' && pr?.baseRefName === 'main' &&
      stored !== undefined && stored.headRef === 'feature' && stored.baseRef === 'main' && stored.headSha === cHead && stored.baseSha === cBase,
    JSON.stringify(body),
  );
}

// --- check 12: merge PR ---
{
  const { status, body } = await gql(
    'mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }',
    { input: { pullRequestId: createdPrGid, mergeMethod: 'SQUASH' } },
  );
  const pr = body.data?.mergePullRequest?.pullRequest;
  const stored = repo.pulls.find((p) => p.number === createdPrNumber);
  ok(
    '12 merge-pull-request',
    status === 200 && pr?.merged === true && stored?.merged === true && stored?.state === 'closed' &&
      typeof stored?.mergeCommitSha === 'string' && /^[0-9a-f]{40}$/.test(stored.mergeCommitSha),
    JSON.stringify(body),
  );
}

// --- check 13: add comment (store must list it on the issue) ---
{
  const { status, body } = await gql(
    'mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }',
    { input: { subjectId: issueIdFirst, body: 'hello from graphql' } },
  );
  const node = body.data?.addComment?.commentEdge?.node;
  const stored = repo.issues.find((i) => i.number === 1)?.comments ?? [];
  ok(
    '13 add-comment',
    status === 200 && node?.body === 'hello from graphql' && typeof node?.id === 'string' && node.id.length > 0 &&
      stored.some((c) => c.body === 'hello from graphql'),
    JSON.stringify(body),
  );
}

// --- check 14: invalid field -> 200 with errors naming the field ---
{
  const { status, body } = await gql('query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }');
  const msgs = (body.errors ?? []).map((e) => e.message).join(' ');
  ok(
    '14 invalid-field',
    status === 200 && Array.isArray(body.errors) && body.errors.length >= 1 && msgs.includes('noSuchFieldOnViewer'),
    JSON.stringify(body),
  );
}

// --- check 15: unauthenticated -> 401 ---
{
  const { status } = await gql('query ViewerLogin { viewer { login } }', {}, false);
  ok('15 unauthenticated', status === 401, `status=${status}`);
}

// --- check 18: batched operations, 2 responses in order ---
{
  const { status, body } = await gqlRaw([
    { query: 'query ViewerLogin { viewer { login } }' },
    { query: 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' },
  ]);
  const firstOk = Array.isArray(body) && body.length === 2 && body[0]?.data?.viewer?.login === VIEWER.login;
  const secondOk = Array.isArray(body) && (body[1]?.data?.Issue?.fields ?? []).some((f) => f.name === 'title');
  ok('18 batched-operations', status === 200 && firstOk && secondOk, JSON.stringify(body));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed${fail > 0 ? ` — FAILED: ${failures.join(', ')}` : ''}`);
process.exit(fail ? 1 : 0);
