'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SID, SID2, api } = require('./helpers');

const files = (dir) => { try { return fs.readdirSync(dir).sort(); } catch (_) { return []; } };

test('a message is written whole into the inbox, with the protocol fields, and the signal is touched', (t) => {
  const { at } = api(t);
  const r = at.deliverSync(SID, '  Is the deploy fixed?  ', { meta: { from_app: 'web' } });
  assert.deepEqual([r.thread, r.n], ['q1', 1]);
  const p = at.layout(SID);
  assert.deepEqual(files(p.inbox), [`${r.id}.json`]); // no temp file left
  const m = JSON.parse(fs.readFileSync(path.join(p.inbox, `${r.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(m).sort(), ['at', 'from', 'id', 'kind', 'meta', 'session_id', 'text', 'thread', 'v']);
  assert.deepEqual([m.thread, m.kind, m.from, m.text, m.meta.from_app], ['q1', 'turn', 'person', 'Is the deploy fixed?', 'web']);
  assert.equal(JSON.parse(fs.readFileSync(p.signal, 'utf8')).reason, 'message');
  assert.deepEqual(at.events().map((e) => e.event), ['queued']);
  assert.equal(at.threads(SID)[0].title, 'Is the deploy fixed?');
});

test('threads: a new one per message without a thread, the same one by number, reopened when it was resolved', (t) => {
  const { at } = api(t);
  at.deliverSync(SID, 'First subject');
  at.deliverSync(SID, 'Second subject', { title: 'Docs' });
  at.deliverSync(SID, 'More on the first', { thread: 'q1' });
  at.resolve(SID, 2);
  assert.equal(at.thread(SID, 2).status, 'resolved');
  at.deliverSync(SID, 'Docs again', { thread: 2 });
  assert.equal(at.thread(SID, 2).status, 'open');
  at.deliverSync(SID, 'A number nobody opened', { thread: 7 });
  assert.deepEqual(at.threads(SID).map((x) => [x.n, x.title]), [[1, 'First subject'], [2, 'Docs'], [7, '']]);
  assert.deepEqual(at.pending(SID).map((m) => m.thread), ['q1', 'q2', 'q1', 'q2', 'q7']);
  assert.throws(() => at.deliverSync(SID, 'x', { thread: 'ide' }), /not a thread/);
  assert.throws(() => at.deliverSync(SID, '   '), /empty/);
});

test('ids written in the same millisecond still sort in the order they were written', () => {
  const { newId } = require('../src/util');
  const ids = Array.from({ length: 50 }, () => newId(1000));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids.map((id) => id.split('-')[0])).size, 50);
});

test('a derived thread keeps where it came from; notices and thread:false have no thread', (t) => {
  const { at } = api(t);
  at.deliverSync(SID, 'Main subject');
  const d = at.deliverSync(SID, 'A side question', { parent: 1 });
  assert.equal(at.thread(SID, d.n).parent, 'q1');
  const n = at.notice(SID, 'CI is slow today.');
  const plain = at.deliverSync(SID, 'Just text', { thread: false });
  assert.equal(n.thread, null);
  assert.equal(plain.thread, null);
  assert.deepEqual(at.pending(SID).slice(2).map((m) => [m.kind, m.thread]), [['notice', null], ['turn', null]]);
});

test('a claim takes the whole batch, oldest first, into delivered/ with delivered_at, session_id and via', (t) => {
  const { at } = api(t);
  const a = at.deliverSync(SID, 'one');
  const b = at.deliverSync(SID, 'two', { thread: 1 });
  const c = at.notice(SID, 'three');
  const got = at.claim(SID, { via: 'wake' });
  assert.deepEqual(got.map((m) => m.id), [a.id, b.id, c.id]);
  for (const m of got) {
    assert.equal(m.session_id, SID);
    assert.equal(m.via, 'wake');
    assert.ok(Date.parse(m.delivered_at));
  }
  assert.deepEqual(at.pending(SID), []);
  assert.deepEqual(at.claim(SID), []);
  assert.deepEqual(at.delivered(SID).map((m) => m.id), [a.id, b.id, c.id]);
  assert.deepEqual(at.events({ session: SID }).filter((e) => e.event === 'delivered').map((e) => [e.id, e.via]), [[a.id, 'wake'], [b.id, 'wake'], [c.id, 'wake']]);
  assert.equal(at.formatDelivery(SID, got, { instruct: false }), '[Q1 · one] one\n\n[Q1 · one] two\n\nthree');
});

test('nothing ever removes or renames the signal file, and it stays the same file', (t) => {
  const { at } = api(t);
  const signal = at.layout(SID).signal;
  at.arm(SID, { source: 'startup' });
  const ino = fs.statSync(signal, { bigint: true }).ino;
  const hits = [];
  const orig = { unlinkSync: fs.unlinkSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
  const watch = (name) => (p, ...rest) => {
    if ([p, rest[0]].some((x) => typeof x === 'string' && path.resolve(x) === path.resolve(signal))) hits.push(name);
    return orig[name](p, ...rest);
  };
  fs.unlinkSync = watch('unlinkSync'); fs.renameSync = watch('renameSync'); fs.rmSync = watch('rmSync');
  try {
    for (let i = 0; i < 5; i++) at.deliverSync(SID, `message ${i}`);
    at.touch(SID, 'manual');
    at.claim(SID, { via: 'wake' });
    const x = at.deliverSync(SID, 'to take back');
    at.retract(SID, x.id);
    at.deliverSync(SID, 'to hand back');
    at.handBack(SID, {});
    at.disarm(SID, {});
    at.arm(SID, { source: 'resume' });
  } finally { Object.assign(fs, orig); }
  assert.deepEqual(hits, []);
  assert.ok(fs.existsSync(signal));
  assert.equal(fs.statSync(signal, { bigint: true }).ino, ino);
});

test('two processes claiming at once: every message delivered exactly once', async (t) => {
  const { at, root } = api(t);
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(at.deliverSync(SID, `m${i}`, { thread: (i % 3) + 1 }).id);
  const go = path.join(root, 'go');
  const script = `
    const fs = require('fs');
    const at = require(${JSON.stringify(path.join(__dirname, '..', 'src'))}).open({ home: process.argv[1], claudeDir: process.argv[2], env: {}, liveness: () => ({}) });
    while (!fs.existsSync(process.argv[3])) {}
    process.stdout.write(JSON.stringify(at.claim(process.argv[4], { via: 'p' + process.pid }).map((m) => m.id)));
  `;
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, at.home, at.claudeDir, go, SID]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(out))));
  });
  const kids = [run(), run(), run(), run()];
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(go, '');
  const got = (await Promise.all(kids)).flat();
  assert.equal(got.length, ids.length);
  assert.deepEqual([...new Set(got)].sort(), [...ids].sort());
  assert.equal(at.delivered(SID).length, ids.length);
});

test('retract takes back a message still pending, and only then', (t) => {
  const { at } = api(t);
  const a = at.deliverSync(SID, 'oops');
  assert.equal(at.retract(SID, a.id), true);
  assert.equal(at.retract(SID, a.id), false);
  assert.deepEqual(at.pending(SID), []);
  const b = at.deliverSync(SID, 'kept');
  at.claim(SID);
  assert.equal(at.retract(SID, b.id), false);
});

test('hand back: to another session (touched) or out to returned/, each with where it came from', (t) => {
  const { at } = api(t);
  at.deliverSync(SID, 'for whoever comes next');
  at.notice(SID, 'a notice');
  at.ensureSession(SID2);
  const before = fs.readFileSync(at.layout(SID2).signal, 'utf8');
  const moved = at.handBack(SID, { to: SID2 });
  assert.equal(moved.length, 2);
  assert.deepEqual(at.pending(SID), []);
  assert.deepEqual(at.pending(SID2).map((m) => [m.session_id, m.moved_from]), [[SID2, SID], [SID2, SID]]);
  assert.notEqual(fs.readFileSync(at.layout(SID2).signal, 'utf8'), before);
  at.deliverSync(SID, 'nobody in particular');
  at.handBack(SID);
  assert.deepEqual(at.returned().map((m) => [m.text, m.returned_from]), [['nobody in particular', SID]]);
  assert.deepEqual(at.events().filter((e) => e.event === 'handed_back').map((e) => e.to), [SID2, SID2, null]);
});

test('listening: alive and armed, its vigia up, or mid-turn; never when it is gone or armed before it started', (t) => {
  const { at, live } = api(t);
  const now = Date.now();
  live.set(SID, { alive: true, busy: false, startedAt: now - 1000 });
  assert.equal(at.listening(SID).listening, false);
  at.arm(SID, { source: 'startup' });
  assert.deepEqual([at.listening(SID).listening, at.listening(SID).why], [true, 'watch']);
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() + 60000 }); // the process restarted after it armed
  assert.equal(at.listening(SID).listening, false);
  fs.writeFileSync(at.layout(SID).vigia, 'token');
  assert.equal(at.listening(SID).why, 'vigia');
  fs.unlinkSync(at.layout(SID).vigia);
  live.set(SID, { alive: true, busy: true, startedAt: Date.now() + 60000 });
  assert.equal(at.listening(SID).why, 'busy');
  live.set(SID, { alive: false, busy: false, startedAt: now });
  assert.equal(at.listening(SID).listening, false);
  at.arm(SID2, {}); // not in the registry at all: the watch alone says it
  assert.deepEqual([at.listening(SID2).listening, at.listening(SID2).alive], [true, null]);
  at.disarm(SID2, {});
  assert.equal(at.listening(SID2).listening, false);
});

test('the end keeps undelivered messages by default, or returns them (onEnd: return)', (t) => {
  const keep = api(t).at;
  keep.deliverSync(SID, 'still here');
  assert.equal(keep.disarm(SID).length, 1);
  assert.equal(keep.pending(SID).length, 1);
  assert.deepEqual(keep.events().pop().pending, [keep.pending(SID)[0].id]);
  const ret = api(t, { config: { onEnd: 'return' } }).at;
  ret.deliverSync(SID, 'goes back');
  ret.disarm(SID);
  assert.deepEqual(ret.pending(SID), []);
  assert.equal(ret.returned().length, 1);
});

test('answers to a thread with a release key are recorded for a policy hook', (t) => {
  const { at } = api(t);
  const ask = at.openThread(SID, { title: 'Push the release?', text: 'May I push v1.2?', by: 'session', type: 'authorization', alert: true, release: 'git' });
  assert.deepEqual([ask.opened_by, ask.type, ask.alert, ask.release], ['session', 'authorization', true, 'git']);
  assert.deepEqual(at.logged(SID).map((e) => [e.thread, e.from, e.text]), [[ask.id, 'session', 'May I push v1.2?']]);
  at.deliverSync(SID, 'Unrelated');
  at.deliverSync(SID, 'yes, push it', { thread: ask.n });
  const a = at.latestAnswer(SID, 'git');
  assert.deepEqual([a.session_id, a.thread, a.release, a.text], [SID, ask.id, 'git', 'yes, push it']);
  assert.equal(at.latestAnswer(SID, 'index'), null);
  assert.equal(at.answers(SID).length, 1);
});

test('the instruction goes with the first batch that has a thread, once, in the session\'s own words when it has them', (t) => {
  const { at } = api(t, { config: { app: 'the Dev app' } });
  at.notice(SID, 'just a notice');
  assert.equal(at.formatDelivery(SID, at.claim(SID)), 'just a notice');
  at.deliverSync(SID, 'first');
  const first = at.formatDelivery(SID, at.claim(SID));
  assert.match(first, /^This session is followed in the Dev app[\s\S]*\n\n\[Q1 · first\] first$/);
  at.deliverSync(SID, 'second', { thread: 1 });
  assert.equal(at.formatDelivery(SID, at.claim(SID)), '[Q1 · first] second');
  assert.match(at.reminder(SID), /^This session is followed/);

  at.register(SID2, { instruction: 'Answer in threads, as {app} shows them.', app: 'the other app' });
  at.deliverSync(SID2, 'hi');
  assert.match(at.formatDelivery(SID2, at.claim(SID2)), /^Answer in threads, as the other app shows them\.\n\n\[Q1 · hi\] hi$/);

  const told = api(t).at;
  told.register(SID, { instructed: true });
  told.deliverSync(SID, 'already told');
  assert.equal(told.formatDelivery(SID, told.claim(SID)), '[Q1 · already told] already told');
  const off = api(t, { config: { instructions: false } }).at;
  off.deliverSync(SID, 'quiet');
  assert.equal(off.formatDelivery(SID, off.claim(SID)), '[Q1 · quiet] quiet');
  assert.equal(off.reminder(SID), null);
});

test('the transform runs before queueing and the original is kept', async (t) => {
  const { at } = api(t);
  const r = await at.deliver(SID, 'hi', { transform: async (text) => `hello (${text})` });
  const m = at.pending(SID).find((x) => x.id === r.id);
  assert.deepEqual([m.text, m.original], ['hello (hi)', 'hi']);
  const plain = await at.deliver(SID, 'no transform', { thread: 1 });
  assert.equal(at.pending(SID).find((x) => x.id === plain.id).original, undefined);
});

test('rename, resolve, reopen and import keep the registry in order', (t) => {
  const { at } = api(t);
  at.deliverSync(SID, 'one');
  at.rename(SID, 1, 'Better title', { by: 'person' });
  assert.deepEqual([at.thread(SID, 1).title, at.thread(SID, 1).title_by], ['Better title', 'person']);
  at.resolve(SID, 'q1', { by: 'Ana' });
  assert.deepEqual([at.thread(SID, 1).status, at.thread(SID, 1).resolved_by], ['resolved', 'Ana']);
  at.reopen(SID, 1);
  assert.equal(at.thread(SID, 1).status, 'open');
  at.importThreads(SID, [{ n: 5, title: 'From before', opened_by: 'session', key: 'c:abc:0', parent: 'q1' }]);
  assert.deepEqual(at.threads(SID).map((x) => x.n), [1, 5]);
  assert.equal(at.deliverSync(SID, 'next one').n, 6);
  at.setThread(SID, 5, { alert: true, release: 'deploy' });
  assert.deepEqual([at.thread(SID, 5).alert, at.thread(SID, 5).release], [true, 'deploy']);
});

test('followEvents sees what other writers append', async (t) => {
  const { at } = api(t);
  const seen = [];
  const stop = at.followEvents((e) => seen.push(e.event), { intervalMs: 20 });
  at.deliverSync(SID, 'hello');
  at.claim(SID);
  await new Promise((r) => setTimeout(r, 120));
  stop();
  assert.deepEqual(seen, ['queued', 'delivered']);
});

test('session ids with path separators or dots are refused', (t) => {
  const { at } = api(t);
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '', 'a..b']) {
    assert.throws(() => at.deliverSync(bad, 'x'), /not a session id/);
    assert.deepEqual(at.claim(bad), []);
  }
});
