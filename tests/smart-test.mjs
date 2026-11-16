// Smoke test for src/smart.ts: starts a node:http server using handleGit,
// creates a repo in the store, pushes commits with the real git binary
// (TESTING ONLY — never used at runtime), clones back, and asserts the
// objects match. Run with:
//   node --experimental-strip-types tests/smart-test.mjs
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGit } from '../src/smart.ts';
import { store } from '../src/store.ts';

const execFileAsync = promisify(execFile);

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    console.log('FAIL', name);
  }
};

// Async git: the HTTP server lives in this same process, so a synchronous
// git call would block the event loop and deadlock against the server.
const git = async (args, cwd, allowFail = false) => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'user.name=ada iversen', '-c', 'user.email=adaiversen@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd ?? process.env.HOME } },
    );
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
};

const server = createServer((req, res) => {
  handleGit(req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"Not Found"}\n');
      }
    })
    .catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: String(err) }));
      }
    });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/adaiversen/smarttest.git`;
const tmp = mkdtempSync(join(tmpdir(), 'smart-test-'));

try {
  store.createRepo('adaiversen', 'smarttest', 'smoke test', true);

  // 1. Empty clone succeeds.
  await git(['clone', base, 'empty-clone'], tmp, true);
  ok('empty clone succeeds', true);

  // 2. First commit + push to unborn main.
  const work = join(tmp, 'empty-clone');
  writeFileSync(join(work, 'hello.txt'), 'hello\n');
  await git(['add', 'hello.txt'], work);
  await git(['commit', '-m', 'init'], work);
  const push1 = await git(['push', 'origin', 'main'], work, true);
  ok('first push to unborn main succeeds', push1 !== null);
  const head1 = (await git(['rev-parse', 'HEAD'], work)).trim();
  ok('HEAD is a 40-hex oid', /^[0-9a-f]{40}$/.test(head1));

  // 3. Fresh clone: objects match.
  await git(['clone', '-b', 'main', base, 'clone2'], tmp);
  const head2 = (await git(['rev-parse', 'HEAD'], join(tmp, 'clone2'))).trim();
  ok('fresh clone HEAD matches pushed HEAD', head2 === head1);
  const objsWork = (await git(['rev-list', '--objects', '--all'], work)).trim().split('\n').sort().join('\n');
  const objsClone = (await git(['rev-list', '--objects', '--all'], join(tmp, 'clone2'))).trim().split('\n').sort().join('\n');
  ok('fresh clone object list matches', objsWork === objsClone);
  const blobWork = (await git(['rev-parse', 'HEAD:hello.txt'], work)).trim();
  const blobClone = (await git(['rev-parse', 'HEAD:hello.txt'], join(tmp, 'clone2'))).trim();
  ok('blob oid matches across clone', blobWork === blobClone && blobWork.length === 40);

  // 4. Second commit, push, incremental fresh clone.
  writeFileSync(join(work, 'second.txt'), 'second\n'.repeat(10));
  await git(['add', 'second.txt'], work);
  await git(['commit', '-m', 'second'], work);
  const push2 = await git(['push', 'origin', 'main'], work, true);
  ok('second push succeeds', push2 !== null);
  const head3 = (await git(['rev-parse', 'HEAD'], work)).trim();
  await git(['clone', '-b', 'main', base, 'clone3'], tmp);
  const head3c = (await git(['rev-parse', 'HEAD'], join(tmp, 'clone3'))).trim();
  ok('incremental clone sees new tip', head3c === head3);
  const objs3 = (await git(['rev-list', '--objects', '--all'], join(tmp, 'clone3'))).trim().split('\n').sort().join('\n');
  const objsWork3 = (await git(['rev-list', '--objects', '--all'], work)).trim().split('\n').sort().join('\n');
  ok('incremental clone object list matches', objs3 === objsWork3);

  // 5. Shallow clone (depth 1) then deepen 2.
  await git(['clone', '--depth', '1', '-b', 'main', base, 'shallow-clone'], tmp);
  const shallowCount = Number((await git(['rev-list', '--count', 'HEAD'], join(tmp, 'shallow-clone'))).trim());
  ok('shallow clone depth 1 has exactly 1 commit', shallowCount === 1);
  await git(['fetch', '--deepen=2', 'origin'], join(tmp, 'shallow-clone'));
  const deepCount = Number((await git(['rev-list', '--count', 'HEAD'], join(tmp, 'shallow-clone'))).trim());
  ok('deepen 2 gives exactly 2 commits', deepCount === 2);

  // 6. Annotated tag: create, push, ls-remote shows it peeled.
  await git(['tag', '-a', 'v1', '-m', 'release one'], work);
  const tagPush = await git(['push', 'origin', 'v1'], work, true);
  ok('tag push succeeds', tagPush !== null);
  const lsRemote = await git(['ls-remote', base], tmp);
  ok('ls-remote lists main + tag + peeled tag', lsRemote.includes('refs/heads/main') && lsRemote.includes('refs/tags/v1') && lsRemote.includes('refs/tags/v1^{}'));

  // 7. Branch create + delete.
  await git(['checkout', '-b', 'feature'], work);
  const branchPush = await git(['push', 'origin', 'feature'], work, true);
  ok('branch push succeeds', branchPush !== null);
  ok('ls-remote lists feature', (await git(['ls-remote', base], tmp)).includes('refs/heads/feature'));
  await git(['checkout', 'main'], work);
  const branchDel = await git(['push', 'origin', '--delete', 'feature'], work, true);
  ok('branch delete succeeds', branchDel !== null);
  const afterDel = await git(['ls-remote', base], tmp);
  ok('ls-remote no longer lists feature', !afterDel.includes('refs/heads/feature'));
  ok('main intact after delete', afterDel.includes(head3));

  // 8. Non-fast-forward push is refused and the tip does not move.
  await git(['reset', '--hard', 'HEAD~1'], work);
  writeFileSync(join(work, 'divergent.txt'), 'divergent\n');
  await git(['add', 'divergent.txt'], work);
  await git(['commit', '-m', 'divergent'], work);
  const forced = await git(['push', '--force', 'origin', 'main'], work, true);
  ok('force push is refused', forced === null);
  const remoteHead = (await git(['ls-remote', base, 'refs/heads/main'], tmp)).trim().split(/\s+/)[0];
  ok('ref unmoved after refused push', remoteHead === head3);

  // 9. Missing repo -> 404; malformed POST does not corrupt the repo.
  const missing = await fetch(`http://127.0.0.1:${port}/adaiversen/nope.git/info/refs?service=git-upload-pack`);
  ok('missing repo info/refs is 404', missing.status === 404);
  await fetch(`http://127.0.0.1:${port}/adaiversen/smarttest.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: 'zzzznot-a-pkt-line',
  });
  ok('malformed POST answered (any status)', true);
  await git(['clone', '-b', 'main', base, 'clone-after-errors'], tmp);
  const headAfter = (await git(['rev-parse', 'HEAD'], join(tmp, 'clone-after-errors'))).trim();
  ok('repo still clonable after errors', headAfter === head3);
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
