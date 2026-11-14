'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SID, api, T, writeTranscript } = require('./helpers');

/** A session with a transcript where the start hook said. */
function setup(t, lines, opts) {
  const ctx = api(t, opts);
  const file = path.join(ctx.root, 'claude', 'projects', 'p', `${SID}.jsonl`);
  if (lines) writeTranscript(file, lines);
  ctx.at.arm(SID, { source: 'startup', transcript_path: file });
  ctx.live.set(SID, { alive: true, busy: false, startedAt: Date.now() - 60000 });
  return { ...ctx, file };
}

test('threads come out in the shape chat-thread\'s createThreads takes', (t) => {
  const { at, file } = setup(t);
  const q1 = at.deliverSync(SID, 'Is the deploy fixed?');
  const delivered = at.claim(SID, { via: 'wake' });
  writeTranscript(file, [
    T.rewake('u1', 's', at.formatDelivery(SID, delivered, { instruct: false })),
    T.assistant('a1', [T.text('Yes, fixed and deployed.')]),
  ]);
  const v = at.view(SID);
  assert.equal(v.threads.length, 1);
  const th = v.threads[0];
  assert.deepEqual(
    { id: th.id, n: th.n, title: th.title, status: th.status, tone: th.tone, state: th.state, origin: th.origin, parent: th.parent },
    { id: 'q1', n: 1, title: 'Is the deploy fixed?', status: 'open', tone: 'wait', state: 'waiting', origin: '', parent: null },
  );
  // the delivered record stands for the batch in the transcript: one message, its id, read once answered
  assert.deepEqual(th.messages.map((m) => [m.id, m.from, m.text, m.state]), [
    [q1.id, 'me', 'Is the deploy fixed?', 'read'],
    ['a1:0', 'other', 'Yes, fixed and deployed.', undefined],
  ]);
  assert.deepEqual([v.session.state, v.session.alive, v.session.listening], ['waiting', true, true]);
});

test('states: queued, sent, working (with the activity), stopped, resolved', (t) => {
  const { at, live, file } = setup(t, []);
  at.deliverSync(SID, 'first');
  assert.equal(at.view(SID).threads[0].state, 'queued');
  assert.deepEqual(at.view(SID).threads[0].messages[0].state, 'queued');
  const got = at.claim(SID);
  writeTranscript(file, [T.rewake('u1', 's', at.formatDelivery(SID, got, { instruct: false }))], { append: true });
  assert.equal(at.view(SID).threads[0].state, 'sent');
  writeTranscript(file, [T.assistant('a1', [T.tool('Bash', { command: 'npm test', description: 'Run the tests' })])], { append: true });
  live.set(SID, { alive: true, busy: true, startedAt: Date.now() - 60000 });
  const w = at.view(SID).threads[0];
  assert.deepEqual([w.state, w.tone, w.activity], ['working', 'busy', 'Bash · Run the tests']);
  live.set(SID, { alive: false, busy: false, startedAt: Date.now() - 60000 });
  assert.deepEqual([at.view(SID).threads[0].state, at.view(SID).threads[0].label], ['stopped', 'Session closed']);
  at.resolve(SID, 1);
  assert.deepEqual([at.view(SID).threads[0].status, at.view(SID).threads[0].state], ['resolved', 'resolved']);
  assert.equal(at.view(SID, { labels: { stopped: 'Aba fechada' } }).session.state, 'stopped');
});

test('threads the session opened and the IDE thread get numbers; persist keeps them', (t) => {
  const { at } = setup(t, [
    T.user('u0', 'typed straight in the IDE'),
    T.assistant('a0', [T.text('Answer in the IDE thread.\n[Q new · Side question]\nShould I also bump the version?')]),
  ]);
  at.deliverSync(SID, 'From the app');
  const v = at.view(SID);
  // numbers go in the order threads are first seen: the app's was registered before this view
  assert.deepEqual(v.threads.map((x) => [x.n, x.title, x.origin, x.parent && x.parent.n]), [
    [1, 'From the app', '', null],
    [2, '', 'typed in the IDE', null],
    [3, 'Side question', 'opened by the session', 2],
  ]);
  assert.equal(v.threads[2].titleByAI, true);
  // not persisted: the registry still has only the app's thread, and a second view numbers the same
  assert.deepEqual(at.threads(SID).map((x) => x.n), [1]);
  assert.deepEqual(at.view(SID).threads.map((x) => x.n), [1, 2, 3]);
  at.view(SID, { persist: true });
  assert.deepEqual(at.threads(SID).map((x) => [x.n, x.key ? x.key.split(':')[0] : null]), [[1, null], [2, 'ide'], [3, 'new']]);
});

test('a title the session gives wins over the old one, unless the person renamed it later', (t) => {
  const { at, file } = setup(t, []);
  at.deliverSync(SID, 'vague');
  writeTranscript(file, [T.assistant('a1', [T.text('[Q1 → Login timeout on mobile]')], { timestamp: new Date(Date.now() - 60000).toISOString() })], { append: true });
  assert.deepEqual([at.view(SID).threads[0].title, at.view(SID).threads[0].titleByAI], ['Login timeout on mobile', true]);
  at.rename(SID, 1, 'Mine', { by: 'person' });
  assert.deepEqual([at.view(SID).threads[0].title, at.view(SID).threads[0].titleBy], ['Mine', 'person']);
});

test("the person's message sits after the reply it was not there for (ordered by delivery)", (t) => {
  const T0 = Date.parse('2026-11-14T05:00:00.000Z');
  const when = (dt) => new Date(T0 + dt).toISOString();
  let clock = T0;
  const { at, file } = setup(t, [], { now: () => clock });
  at.deliverSync(SID, 'm1');
  clock += 1000;
  const b1 = at.claim(SID);
  writeTranscript(file, [T.rewake('u1', 's', at.formatDelivery(SID, b1, { instruct: false }), { timestamp: when(1100) })], { append: true });
  clock += 1000;
  at.deliverSync(SID, 'm2', { thread: 1 }); // written while the session was answering m1
  writeTranscript(file, [T.assistant('a1', [T.text('answer to m1')], { timestamp: when(3000) })], { append: true });
  clock += 2000;
  at.claim(SID);
  const msgs = at.view(SID).threads[0].messages;
  assert.deepEqual(msgs.map((m) => [m.text, m.state]), [['m1', 'read'], ['answer to m1', undefined], ['m2', 'delivered']]);
  assert.equal(msgs[2].at, when(2000)); // shown with the time it was written
});

test('an ask opened by the session shows its message, with type, red flag and release key', (t) => {
  const { at } = setup(t, []);
  at.openThread(SID, { title: 'Push?', text: 'May I push?', by: 'session', type: 'authorization', alert: true, release: 'git' });
  const th = at.view(SID).threads[0];
  assert.deepEqual([th.origin, th.type, th.alert, th.release, th.state], ['opened by the session', 'authorization', true, 'git', 'waiting']);
  assert.deepEqual(th.messages.map((m) => [m.from, m.text]), [['other', 'May I push?']]);
});

test('a batch that reached the session some other way still shows from the transcript', (t) => {
  const { at } = setup(t, [
    T.rewake('u1', 'relay: start prompt', 'Instructions...\n\n[Q1 · Request] Build the thing'),
    T.assistant('a1', [T.text('Building.')]),
  ]);
  const th = at.view(SID).threads[0];
  assert.deepEqual(th.messages.map((m) => [m.from, m.text]), [['me', 'Build the thing'], ['other', 'Building.']]);
});
