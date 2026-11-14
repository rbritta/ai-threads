'use strict';
/* What an app plugs into: the delivered command, the idle tick, footers, its own thread ids, release lists,
 * retract records and the session's replies per thread. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeHooks } = require('../src/claude-code');
const install = require('../src/claude-code/install');
const command = require('../src/command');
const { SID, api, tmp, T, writeTranscript } = require('./helpers');

const fast = { vigia: { stepMs: 20, maxMs: 3000, aliveCheckMs: 60 } };
const ON_DELIVERED = { command: ['node', 'app.js', 'delivered'] };
const TICK = { command: ['node', 'app.js', 'tick'], everyMs: 3600000 };

// ── G1: onDelivered ───────────────────────────────────────────────────────────

test('onDelivered: every claimed batch runs the command once, with the records', (t) => {
  const { at, commands } = api(t, { config: { onDelivered: ON_DELIVERED } });
  const a = at.deliverSync(SID, 'one', { meta: { app: 7 } });
  const b = at.notice(SID, 'two');
  at.claim(SID, { via: 'wake' });
  assert.equal(commands.length, 1);
  const { spec, payload } = commands[0];
  assert.deepEqual(spec, ON_DELIVERED);
  assert.deepEqual([payload.event, payload.session_id, payload.via], ['delivered', SID, 'wake']);
  assert.deepEqual(payload.messages.map((m) => [m.id, m.via, !!m.delivered_at]), [[a.id, 'wake', true], [b.id, 'wake', true]]);
  assert.deepEqual(payload.messages[0].meta, { app: 7 });
  at.claim(SID); // nothing left: no command
  assert.equal(commands.length, 1);
});

test('onDelivered: not configured, nothing runs; a command that throws never stops the delivery', (t) => {
  const quiet = api(t);
  quiet.at.deliverSync(SID, 'x');
  assert.equal(quiet.at.claim(SID).length, 1);
  assert.equal(quiet.commands.length, 0);
  const broken = api(t, { config: { onDelivered: ON_DELIVERED }, runCommand: () => { throw new Error('boom'); } });
  broken.at.deliverSync(SID, 'y');
  assert.equal(broken.at.claim(SID).length, 1);
  assert.equal(broken.at.delivered(SID).length, 1);
});

test('onDelivered: the real command gets the records on stdin, detached', async (t) => {
  const root = tmp(t);
  const out = path.join(root, 'got.json');
  const code = 'require("fs").writeFileSync(process.argv[1], require("fs").readFileSync(0))';
  const { at } = api(t, { config: { onDelivered: { command: [process.execPath, '-e', code, out] } }, runCommand: null });
  const sent = at.deliverSync(SID, 'over the wire');
  at.claim(SID, { via: 'vigia' });
  for (let i = 0; i < 200 && !(fs.existsSync(out) && fs.readFileSync(out, 'utf8').endsWith('}')); i++) await new Promise((r) => setTimeout(r, 50));
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual([got.event, got.via, got.messages[0].id, got.messages[0].text], ['delivered', 'vigia', sent.id, 'over the wire']);
});

test('a command is runnable only when it names something', () => {
  assert.equal(command.runnable(null), false);
  assert.equal(command.runnable({}), false);
  assert.equal(command.runnable({ command: '  ' }), false);
  assert.equal(command.runnable({ command: [] }), false);
  assert.equal(command.runnable({ command: 'app --tick' }), true);
  assert.equal(command.runnable({ command: ['app'] }), true);
});

// ── G4: the idle tick ─────────────────────────────────────────────────────────

test('tick: the vigia runs it when the session goes idle, at most once per everyMs; wake on every touch', async (t) => {
  const { at, live, commands } = api(t, { config: { ...fast, tick: TICK } });
  const hooks = makeHooks(at, { env: {} });
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() });
  at.register(SID);
  const first = hooks.vigia({ session_id: SID });
  await new Promise((r) => setTimeout(r, 60));
  const second = hooks.vigia({ session_id: SID }); // the next Stop: within everyMs, no new tick
  assert.equal(await first, null);
  live.set(SID, { alive: false, busy: false, startedAt: Date.now() });
  assert.equal(await second, null);
  const ticks = commands.filter((c) => c.payload.event === 'tick');
  assert.deepEqual(ticks.map((c) => [c.payload.session_id, c.payload.via]), [[SID, 'vigia']]);
  assert.deepEqual(ticks[0].spec, TICK);
  const signal = at.layout(SID).signal;
  hooks.wake({ session_id: SID, file_path: signal });
  hooks.wake({ session_id: SID, file_path: signal });
  assert.deepEqual(commands.filter((c) => c.payload.event === 'tick').map((c) => c.payload.via), ['vigia', 'wake', 'wake']);
  hooks.wake({ session_id: SID, file_path: path.join(path.dirname(signal), 'someone-elses') });
  assert.equal(commands.filter((c) => c.payload.event === 'tick').length, 3);
});

test('tick: none configured or a session never used, nothing runs; everyMs defaults to a minute', async (t) => {
  const quiet = api(t, { config: fast });
  assert.equal(quiet.at.tick(SID, { via: 'wake' }), false);
  const { at, live, commands } = api(t, { config: { ...fast, tick: { command: ['node', 'app.js'] } }, now: () => 1000000 });
  live.set(SID, { alive: false, busy: false, startedAt: Date.now() });
  assert.equal(await makeHooks(at, { env: {} }).vigia({ session_id: SID }), null); // never registered: no vigia, no tick
  assert.equal(commands.length, 0);
  assert.equal(at.tick(SID, { via: 'vigia', throttle: true }), true);
  assert.equal(at.tick(SID, { via: 'vigia', throttle: true }), false);
  assert.equal(JSON.parse(fs.readFileSync(at.layout(SID).tick, 'utf8')).at_ms, 1000000);
});

// ── G2: the texts around a delivery ───────────────────────────────────────────

test('piggybackHeader: a text of its own, or none', (t) => {
  for (const [header, re] of [['Waiting for you:', /^Waiting for you:\n\nlook$/], ['', /^look$/]]) {
    const { at } = api(t, { config: { piggybackHeader: header } });
    at.deliverSync(SID, 'look', { thread: false });
    const out = JSON.parse(makeHooks(at, { env: {} }).prompt({ session_id: SID, prompt: 'go' }).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, re);
  }
});

test('install: rewake message and summary of the app\'s own, kept when installed again without them', () => {
  const home = '/data/ai-threads';
  const mine = install.withHooks({}, home, { rewakeMessage: 'From the app:', rewakeSummary: 'app' });
  for (const ev of ['FileChanged', 'Stop']) {
    assert.deepEqual([mine.hooks[ev][0].hooks[0].rewakeMessage, mine.hooks[ev][0].hooks[0].rewakeSummary], ['From the app:', 'app']);
  }
  assert.deepEqual(install.withHooks(mine, home), mine);
  const plain = install.withHooks({}, home);
  assert.equal(plain.hooks.FileChanged[0].hooks[0].rewakeMessage, install.REWAKE);
  assert.equal(plain.hooks.Stop[0].hooks[0].rewakeSummary, install.REWAKE_SUMMARY);
  assert.equal(install.withHooks(mine, home, { rewakeMessage: 'Changed:' }).hooks.Stop[0].hooks[0].rewakeMessage, 'Changed:');
});

// ── G6: footers ───────────────────────────────────────────────────────────────

test('footers: each distinct one once, after the batch, in the order first seen; never a thread\'s message', (t) => {
  const { at } = api(t);
  at.deliverSync(SID, 'first', { thread: false, footer: 'Reply in the app.' });
  at.notice(SID, 'a notice', { footer: 'No reply needed.' });
  at.deliverSync(SID, 'second', { thread: false, footer: '  Reply in the app.  ' });
  at.deliverSync(SID, 'third', { thread: false, footer: '   ' });
  const got = at.claim(SID);
  assert.equal(got[0].footer, 'Reply in the app.');
  assert.equal('footer' in got[3], false);
  assert.equal(at.formatDelivery(SID, got), 'first\n\na notice\n\nsecond\n\nthird\n\nReply in the app.\n\nNo reply needed.');
});

// ── G3: retracting ────────────────────────────────────────────────────────────

test('retract: the record moves to retracted/ with when and why, and is never delivered', (t) => {
  const { at } = api(t);
  const m = at.deliverSync(SID, 'routed elsewhere', { thread: false });
  assert.equal(at.retract(SID, m.id, { reason: 'rerouted' }), true);
  assert.equal(at.retract(SID, m.id), false);
  const [r] = at.retracted(SID);
  assert.deepEqual([r.id, r.text, r.retracted_reason, typeof r.retracted_at], [m.id, 'routed elsewhere', 'rerouted', 'string']);
  assert.deepEqual(at.claim(SID), []);
  assert.deepEqual(at.events().filter((e) => e.event === 'retracted').map((e) => [e.id, e.reason]), [[m.id, 'rerouted']]);
});

// ── phase B: an app's own thread ids, release lists, replies per thread ───────

test('ref: a message with an app\'s id goes to the thread that has it, or opens one that keeps it', (t) => {
  const { at } = api(t);
  const a = at.deliverSync(SID, 'Can we ship?', { ref: 'conv-7', from: 'app' });
  const b = at.deliverSync(SID, 'Also the docs', { ref: 'conv-8', from: 'app' });
  const c = at.deliverSync(SID, 'Any news?', { ref: 'conv-7', from: 'app' });
  assert.deepEqual([a.n, b.n, c.n], [1, 2, 1]);
  assert.equal(at.thread(SID, { ref: 'conv-7' }).n, 1);
  assert.equal(at.thread(SID, { ref: 'nope' }), null);
  at.resolve(SID, { ref: 'conv-8' });
  assert.equal(at.deliverSync(SID, 'Back to it', { ref: 'conv-8' }).n, 2);
  assert.equal(at.thread(SID, 2).status, 'open');
  assert.equal(at.deliverSync(SID, 'By number wins', { thread: 1, ref: 'conv-8' }).n, 1);
  const opened = at.openThread(SID, { title: 'Asked by the session', ref: 'conv-9' });
  assert.equal(at.thread(SID, { ref: 'conv-9' }).n, opened.n);
  at.setThread(SID, 1, { ref: 'conv-70' });
  assert.equal(at.thread(SID, { ref: 'conv-70' }).n, 1);
  assert.throws(() => at.rename(SID, { ref: 'nope' }, 'x'), /no thread with ref nope/);
});

test('release: one ask may carry several keys; an answer counts for each of them', (t) => {
  const { at } = api(t);
  at.openThread(SID, { title: 'May I commit and push?', by: 'session', release: ['index', 'git', 'git', ' '] });
  assert.deepEqual(at.thread(SID, 1).release, ['index', 'git']);
  at.deliverSync(SID, 'yes', { thread: 1 });
  assert.equal(at.answers(SID, { release: 'git' }).length, 1);
  assert.equal(at.answers(SID, { release: 'index' }).length, 1);
  assert.equal(at.answers(SID, { release: 'deploy' }).length, 0);
  assert.equal(at.latestAnswer(SID, 'index').text, 'yes');
  at.setThread(SID, 1, { release: ['deploy'] });
  assert.equal(at.thread(SID, 1).release, 'deploy');
  at.setThread(SID, 1, { release: [] });
  assert.equal(at.thread(SID, 1).release, null);
});

test('replies: what the session answered in one thread, by number or by the app\'s id', (t) => {
  const { at, root, live } = api(t);
  const file = path.join(root, 'claude', 'projects', 'p', `${SID}.jsonl`);
  at.arm(SID, { source: 'startup', transcript_path: file });
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() - 60000 });
  at.deliverSync(SID, 'Can we ship?', { ref: 'conv-7', from: 'app' });
  at.deliverSync(SID, 'And the docs?', { ref: 'conv-8', from: 'app' });
  const got = at.claim(SID, { via: 'wake' });
  writeTranscript(file, [
    T.rewake('u1', 's', at.formatDelivery(SID, got, { instruct: false })),
    T.assistant('a1', [T.text('[Q1]\nYes, after the tests.\n\n[Q2]\nThe docs are done.')]),
  ]);
  assert.deepEqual(at.replies(SID, { ref: 'conv-7' }).map((r) => r.text), ['Yes, after the tests.']);
  assert.deepEqual(at.replies(SID, 2).map((r) => r.text), ['The docs are done.']);
  assert.deepEqual(at.replies(SID, { ref: 'nope' }), []);
  assert.deepEqual(at.replies(SID, 1, { since: '2999-01-01T00:00:00.000Z' }), []);
  assert.equal(at.view(SID).threads.find((x) => x.n === 1).ref, 'conv-7');
});
