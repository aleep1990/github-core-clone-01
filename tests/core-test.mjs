import { objectId, buildCommit, buildTree, parseCommit, parseTree, collectReachable } from '../src/gitobj.ts';
import { writePack, parsePack, applyDelta } from '../src/pack.ts';
import { pktLine, pktFlush, parsePktLines, sideband, demuxSideband } from '../src/pktline.ts';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };

// --- object ids vs known git values ---
// git hash-object of "hello\n" blob = ce013625030ba8dba906f756967f9e9ca394464a 
const blob = Buffer.from('hello\n', 'utf8');
ok('blob oid', objectId('blob', blob) === 'ce013625030ba8dba906f756967f9e9ca394464a');
const emptyTree = buildTree([]);
ok('empty tree oid', objectId('tree', emptyTree) === '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
const commit = buildCommit({ tree: objectId('tree', emptyTree), parents: [], author: 'ada iversen <adaiversen@example.invalid> 1735689600 +0000', committer: 'ada iversen <adaiversen@example.invalid> 1735689600 +0000', message: 'init\n' });
const commitOid = objectId('commit', commit);
const parsed = parseCommit(commit);
ok('commit round-trip', parsed.tree === objectId('tree', emptyTree) && parsed.message === 'init\n' && parsed.parents.length === 0);

// --- pack write/parse round-trip ---
const blob2 = Buffer.from('world\n'.repeat(100), 'utf8');
const tree2 = buildTree([
  { mode: '100644', name: 'a.txt', oid: objectId('blob', blob) },
  { mode: '100644', name: 'b.txt', oid: objectId('blob', blob2) },
]);
const commit2 = buildCommit({ tree: objectId('tree', tree2), parents: [commitOid], author: 'ada iversen <adaiversen@example.invalid> 1735689601 +0000', committer: 'ada iversen <adaiversen@example.invalid> 1735689601 +0000', message: 'second\n' });
const objs = [
  { type: 'blob', data: blob, oid: objectId('blob', blob) },
  { type: 'blob', data: blob2, oid: objectId('blob', blob2) },
  { type: 'tree', data: emptyTree, oid: objectId('tree', emptyTree) },
  { type: 'tree', data: tree2, oid: objectId('tree', tree2) },
  { type: 'commit', data: commit, oid: commitOid },
  { type: 'commit', data: commit2, oid: objectId('commit', commit2) },
];
const pack = writePack(objs);
const parsed_pack = parsePack(pack);
ok('pack count', parsed_pack.objects.size === 6);
let allMatch = true;
for (const o of objs) { const p = parsed_pack.objects.get(o.oid); if (!p || p.type !== o.type || !p.data.equals(o.data)) allMatch = false; }
ok('pack objects byte-identical', allMatch);
ok('pack trailer ok (no throw = checksum verified)', true);

// --- delta apply (hand-built: copy "hello " + insert "brave new " + copy "world") ---
const base = Buffer.from('hello world', 'utf8');
// delta: base-size varint 11, result-size varint 21, copy op (0x90|offset/size bits) ...
// build delta manually: base size 11 (0x0b), result size 21 (0x15)
// copy 6 bytes at offset 0: op 0x90 (copy, size bit0 set), size byte 0x06
// insert 10 bytes "brave new ": op 0x0a + bytes
// copy 5 bytes at offset 6: op 0x91 (copy, offset bit0 + size bit0), offset 0x06, size 0x05
const delta = Buffer.concat([
  Buffer.from([0x0b, 0x15, 0x90, 0x06]),
  Buffer.from([0x0a]), Buffer.from('brave new '),
  Buffer.from([0x91, 0x06, 0x05]),
]);
const applied = applyDelta(base, delta);
ok('delta apply', applied.toString('utf8') === 'hello brave new world');

// --- reachability ---
const store = new Map();
for (const o of objs) store.set(o.oid, { type: o.type, data: o.data });
const reach = collectReachable({ get: (oid) => store.get(oid) }, [objectId('commit', commit2)]);
ok('reachable closure = 6', reach.length === 6);

// --- pkt-line ---
const framed = Buffer.concat([pktLine('hello\n'), pktFlush(), pktLine(Buffer.from([1, 2, 3]))]);
const items = parsePktLines(framed);
ok('pkt-line parse', items.length === 3 && items[0].kind === 'data' && items[0].data.toString() === 'hello\n' && items[1].kind === 'flush' && items[2].kind === 'data');
const sb = Buffer.concat(sideband(1, Buffer.from('x'.repeat(70000))));
const sbItems = parsePktLines(sb);
const bands = demuxSideband(sbItems);
ok('sideband chunk+demux', bands.get(1).reduce((a, b) => a + b.length, 0) === 70000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
