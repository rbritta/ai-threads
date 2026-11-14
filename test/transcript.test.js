'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const transcript = require('../src/claude-code/transcript');
const { tmp, T, writeTranscript } = require('./helpers');

const pick = (st) => st.messages.map((m) => ({ key: m.key, from: m.from, text: m.text, ...(m.opens ? { opens: m.opens, parent: m.parent } : {}) }));

test('a delivered batch (a rewake), the replies split by marks, a new thread and a rename', (t) => {
  const file = path.join(tmp(t), 'p', 's.jsonl');
  writeTranscript(file, [
    T.rewake('u1', 'ai-threads: messages', '[Q1 · Deploy] Is it fixed?\n\n[Q2 · Docs] Update the docs'),
    T.assistant('a1', [T.text('[Q1]\nYes, fixed.\n[Q2]\nDocs updated.\n[Q new · Cache?]\nShould we add a cache?')]),
    T.assistant('a2', [T.text('[Q2 → Docs for v2]\nOne more thing on the docs.')]),
  ]);
  const st = transcript.read(file, { state: transcript.newState() });
  assert.deepEqual(pick(st), [
    { key: 'q1', from: 'person', text: 'Is it fixed?' },
    { key: 'q2', from: 'person', text: 'Update the docs' },
    { key: 'q1', from: 'session', text: 'Yes, fixed.' },
    { key: 'q2', from: 'session', text: 'Docs updated.' },
    { key: st.messages[4].key, from: 'session', text: 'Should we add a cache?', opens: 'Cache?', parent: 'q2' },
    { key: 'q2', from: 'session', text: 'One more thing on the docs.' },
  ]);
  assert.match(st.messages[4].key, /^new:/);
  assert.deepEqual(st.renames.get(2).title, 'Docs for v2');
  assert.equal(st.current, 'q2');
});

test('text typed in the IDE is the ide thread; IDE tags, meta, tool results, commands and subagents are skipped', (t) => {
  const file = path.join(tmp(t), 'p', 's.jsonl');
  writeTranscript(file, [
    T.user('u1', [{ type: 'text', text: '<ide_selection>some code</ide_selection>\nwhat does this do?' }]),
    T.user('u2', 'meta stuff', { isMeta: true }),
    T.user('u3', [{ type: 'tool_result', content: 'ok' }]),
    T.user('u4', '<command-name>/clear</command-name>'),
    T.user('u5', '<task-notification>\n<summary>agent done</summary>\n</task-notification>'),
    T.assistant('a0', [T.text('from a subagent')], { isSidechain: true }),
    T.assistant('a1', [T.tool('Read', { file_path: '/repo/src/app.js', description: '' }), T.tool('Bash', { command: 'secret-token-123', description: 'Run the tests' }), T.text('It parses the config.')]),
    T.assistant('a2', [T.text('synthetic')], { message: { model: '<synthetic>', content: [T.text('synthetic')] } }),
  ]);
  const st = transcript.read(file, { state: transcript.newState() });
  assert.deepEqual(pick(st), [
    { key: 'ide', from: 'person', text: 'what does this do?' },
    { key: 'ide', from: 'session', text: 'It parses the config.' },
  ]);
  assert.deepEqual(st.messages[1].actions, [{ name: 'Read', text: 'app.js' }, { name: 'Bash', text: 'Run the tests' }]);
  assert.ok(!JSON.stringify(st).includes('secret-token-123'));
});

test('piggybacked messages (prompt hook context) count as delivered; SessionStart context does not', (t) => {
  const file = path.join(tmp(t), 'p', 's.jsonl');
  writeTranscript(file, [
    T.attachment('x1', 'SessionStart', ['This session is followed in an app ... [Q new · short title] ...']),
    T.user('u1', 'and run the linter too'),
    T.attachment('x2', 'UserPromptSubmit', ['Messages for this session that were waiting (ai-threads):\n\n[Q3 · Lint] Fix the lint errors']),
    T.assistant('a1', [T.text('Lint fixed.')]),
  ]);
  const st = transcript.read(file, { state: transcript.newState() });
  assert.deepEqual(pick(st), [
    { key: 'ide', from: 'person', text: 'and run the linter too' },
    { key: 'q3', from: 'person', text: 'Fix the lint errors' },
    { key: 'q3', from: 'session', text: 'Lint fixed.' },
  ]);
});

test('a mark holds across the blocks of one turn, until the next message arrives', (t) => {
  const file = path.join(tmp(t), 'p', 's.jsonl');
  writeTranscript(file, [
    T.rewake('u1', 's', '[Q1 · A] first\n\n[Q2 · B] second'),
    T.assistant('a1', [T.text('[Q1]\nOn one.')]),
    T.assistant('a2', [T.tool('Grep', { pattern: 'foo' })]),
    T.assistant('a3', [T.text('Still on one after the tool.')]),
    T.rewake('u2', 's', '[Q2 · B] and?'),
    T.assistant('a4', [T.text('Two now.')]),
  ]);
  const st = transcript.read(file, { state: transcript.newState() });
  assert.deepEqual(pick(st).filter((m) => m.from === 'session').map((m) => [m.key, m.text]), [['q1', 'On one.'], ['q1', 'Still on one after the tool.'], ['q2', 'Two now.']]);
});

test('each read takes only what the file grew, and a torn last line waits for the rest', (t) => {
  const file = path.join(tmp(t), 'p', 's.jsonl');
  writeTranscript(file, [T.rewake('u1', 's', '[Q1 · A] hi')]);
  const st = transcript.newState();
  transcript.read(file, { state: st });
  assert.equal(st.messages.length, 1);
  const fs = require('fs');
  const line = JSON.stringify(T.assistant('a1', [T.text('hello')]));
  fs.appendFileSync(file, line.slice(0, 20));
  transcript.read(file, { state: st });
  assert.equal(st.messages.length, 1);
  fs.appendFileSync(file, `${line.slice(20)}\n`);
  const seen = [];
  transcript.read(file, { state: st, onEntry: (j) => seen.push(j.type) });
  assert.deepEqual(st.messages.map((m) => m.text), ['hi', 'hello']);
  assert.deepEqual(seen, ['assistant']);
});

test('find looks for <session>.jsonl under <claude dir>/projects', (t) => {
  const root = tmp(t);
  const file = path.join(root, 'projects', 'some-project', 'abc.jsonl');
  writeTranscript(file, [T.user('u1', 'x')]);
  assert.equal(transcript.find(root, 'abc'), file);
  assert.equal(transcript.find(root, 'nope'), null);
});
