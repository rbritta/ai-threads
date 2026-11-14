'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/markup');

test('a thread number from 3, "3", "q3" or "Q3"; nothing else', () => {
  assert.equal(m.threadNumber(3), 3);
  assert.equal(m.threadNumber('3'), 3);
  assert.equal(m.threadNumber('q3'), 3);
  assert.equal(m.threadNumber('Q12'), 12);
  for (const bad of [null, undefined, '', 'x', 'q', '0', 'q0', '-1', 'ide', 'new:abc']) assert.equal(m.threadNumber(bad), null);
});

test('the mark heads a message with a one-line title, brackets out', () => {
  assert.equal(m.mark(3, 'Deploy fails'), '[Q3 · Deploy fails]');
  assert.equal(m.mark(3, 'Two\nlines [x]'), '[Q3 · Two lines x]');
  assert.equal(m.mark(3, ''), '[Q3]');
  assert.ok(m.mark(1, 'x'.repeat(200)).length < 70);
});

test('a batch: thread messages with their marks, notices as they are', () => {
  const out = m.formatBatch([{ n: 1, title: 'Deploy', text: 'Fixed?' }, { text: 'Heads up: CI is slow today.' }, { n: 2, title: 'Docs', text: ' Update them ' }]);
  assert.equal(out, '[Q1 · Deploy] Fixed?\n\nHeads up: CI is slow today.\n\n[Q2 · Docs] Update them');
});

test('a delivered batch splits back into its thread messages, with or without titles', () => {
  const text = m.formatBatch([{ n: 1, title: 'Deploy', text: 'Fixed?\nreally' }, { n: 4, title: '', text: 'Next' }]);
  assert.deepEqual(m.parseDelivered(text), [{ n: 1, title: 'Deploy', text: 'Fixed?\nreally' }, { n: 4, title: '', text: 'Next' }]);
  assert.deepEqual(m.parseDelivered('no marks here'), []);
  const wrapped = `<system-reminder>\nai-threads: messages. [Q2 · A] one\n</system-reminder>\ntrailing`;
  assert.deepEqual(m.parseDelivered(wrapped), [{ n: 2, title: 'A', text: 'one' }]);
});

test('a reply with no mark stays in the thread it started in', () => {
  const r = m.parseReply('Done, the deploy works.', 'q2');
  assert.deepEqual(r.parts, [{ key: 'q2', text: 'Done, the deploy works.' }]);
  assert.equal(r.current, 'q2');
});

test('[Qn] lines move the text below them to that thread, until the next mark', () => {
  const r = m.parseReply('Intro for the current one.\n[Q1]\nAbout one.\nmore one\n[Q3 · Docs]\nAbout three.', 'q2');
  assert.deepEqual(r.parts, [
    { key: 'q2', text: 'Intro for the current one.' },
    { key: 'q1', text: 'About one.\nmore one' },
    { key: 'q3', text: 'About three.' },
  ]);
  assert.equal(r.current, 'q3');
});

test('[Q new · title], and a word the app adds, open a thread, from the thread they were written in', () => {
  const reply = (word) => `Answer to two.\n[Q ${word} · Should we cache?]\nIs a cache worth it here?\n[Q2]\nBack to two.`;
  const opened = [
    { key: 'q2', text: 'Answer to two.' },
    { opens: 'Should we cache?', parent: 'q2', text: 'Is a cache worth it here?' },
    { key: 'q2', text: 'Back to two.' },
  ];
  assert.deepEqual(m.parseReply(reply('new'), 'q2').parts, opened);
  assert.deepEqual(m.parseReply(reply('another'), 'q2', { newWords: ['another'] }).parts, opened);
  assert.deepEqual(m.parseReply(reply('new'), 'q2', { newWords: ['another'] }).parts, opened, 'new still opens');
  assert.equal(m.parseReply(reply('another'), 'q2').parts.some((p) => p.opens), false, 'a word not given is text');
  assert.deepEqual(m.newWords(['another', 'two words', '[x]', 7, 'new']), ['new', 'another']);
});

test('[Qn → title] and [Qn -> title] rename, and leave the text', () => {
  const r = m.parseReply('[Q1 → Deploy on Fridays]\nAll good.\n[Q2 -> Docs]', 'q1');
  assert.deepEqual(r.renames, [{ n: 1, title: 'Deploy on Fridays' }, { n: 2, title: 'Docs' }]);
  assert.deepEqual(r.parts, [{ key: 'q1', text: 'All good.' }]);
});

test('a mark inside a sentence is text, not a mark', () => {
  const r = m.parseReply('As said in [Q1], it works.', 'q2');
  assert.deepEqual(r.parts, [{ key: 'q2', text: 'As said in [Q1], it works.' }]);
});

test('the instruction names the app and the marks; a custom one replaces it', () => {
  const en = m.instruction({ app: 'the Dev app' });
  assert.match(en, /^This session is followed in the Dev app/);
  assert.match(en, /\[Q new · short title\]/);
  assert.match(en, /\[Qn → short title\]/);
  assert.match(m.instruction(), /^This session is followed in an app,/);
  assert.equal(m.instruction({ custom: 'Use threads, {app}.', app: 'X' }), 'Use threads, X.');
});
