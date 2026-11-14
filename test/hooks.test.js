'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeHooks, runHook } = require('../src/claude-code');
const { SID, api, tmp } = require('./helpers');

const fast = { vigia: { stepMs: 20, maxMs: 3000, aliveCheckMs: 60 }, touches: [0.02, 0.02, 0.02] };
const hooksFor = (t, opts = {}) => {
  const ctx = api(t, { config: { ...fast, ...(opts.config || {}) } });
  const hooks = makeHooks(ctx.at, { env: opts.env || {} });
  return { ...ctx, hooks };
};

test('start arms the watch on the signal, every source, and returns only that path', (t) => {
  const { at, hooks } = hooksFor(t);
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const out = JSON.parse(hooks.start({ session_id: SID, source, transcript_path: '/x/s.jsonl' }).stdout);
    assert.deepEqual(out.hookSpecificOutput.watchPaths, [at.layout(SID).signal]);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  }
  assert.equal(JSON.parse(fs.readFileSync(at.layout(SID).armed, 'utf8')).transcript_path, '/x/s.jsonl');
});

test('start re-touches from a detached process only when messages wait', (t) => {
  const { at, hooks, touched } = hooksFor(t);
  hooks.start({ session_id: SID, source: 'startup' });
  assert.deepEqual(touched, []);
  at.deliverSync(SID, 'waiting before the session opened');
  hooks.start({ session_id: SID, source: 'resume' });
  assert.deepEqual(touched, [SID]);
});

test('after a resume, clear or compaction, a session that was told about the marks is reminded', (t) => {
  const { at, hooks } = hooksFor(t);
  const ctx = (source) => JSON.parse(hooks.start({ session_id: SID, source }).stdout).hookSpecificOutput.additionalContext;
  assert.equal(ctx('resume'), undefined);
  at.deliverSync(SID, 'hi');
  at.formatDelivery(SID, at.claim(SID));
  assert.equal(ctx('startup'), undefined);
  assert.match(ctx('compact'), /^This session is followed/);
});

test('never in a subagent, never without a session, and only in the chosen entrypoints', (t) => {
  const { hooks } = hooksFor(t);
  assert.equal(hooks.start({ session_id: SID, agent_id: 'a1' }), null);
  assert.equal(hooks.start({}), null);
  assert.equal(hooks.start({ session_id: '../etc' }), null);
  const only = hooksFor(t, { config: { entrypoints: ['claude-vscode'] }, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.equal(only.hooks.start({ session_id: SID }), null);
  const vs = hooksFor(t, { config: { entrypoints: ['claude-vscode'] }, env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } });
  assert.ok(vs.hooks.start({ session_id: SID }));
});

test('wake: its own signal delivers the batch with exit 2; another tool\'s file does nothing', (t) => {
  const { at, hooks } = hooksFor(t);
  hooks.start({ session_id: SID, source: 'startup' });
  at.deliverSync(SID, 'Is it fixed?');
  at.notice(SID, 'CI is slow');
  assert.equal(hooks.wake({ session_id: SID, file_path: path.join(at.home, 'other', 'file.json') }), null);
  assert.equal(at.pending(SID).length, 2);
  const r = hooks.wake({ session_id: SID, file_path: at.layout(SID).signal });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\n\n\[Q1 · Is it fixed\?\] Is it fixed\?\n\nCI is slow$/);
  assert.deepEqual(at.pending(SID), []);
  assert.equal(hooks.wake({ session_id: SID, file_path: at.layout(SID).signal }), null); // nothing left
  assert.ok(fs.existsSync(at.layout(SID).signal));
});

test('wake never returns watchPaths (that would replace the other tools\' watches)', (t) => {
  const { at, hooks } = hooksFor(t);
  hooks.start({ session_id: SID });
  at.deliverSync(SID, 'x');
  const r = hooks.wake({ session_id: SID, file_path: at.layout(SID).signal });
  assert.equal(r.stdout, undefined);
  assert.equal(hooks.wake({ session_id: SID, file_path: at.layout(SID).signal }), null);
});

test('vigia: delivers what arrives while the session is idle, then leaves its mark', async (t) => {
  const { at, hooks, live } = hooksFor(t);
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() });
  at.register(SID, { title: 'in use' });
  const running = hooks.vigia({ session_id: SID });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(at.listening(SID).why, 'vigia');
  at.deliverSync(SID, 'arrived later');
  const r = await running;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[Q1 · arrived later\] arrived later$/);
  assert.equal(fs.existsSync(at.layout(SID).vigia), false);
  assert.equal(at.events().filter((e) => e.event === 'delivered')[0].via, 'vigia');
});

test('vigia: never stays in a session ai-threads was never used in', async (t) => {
  const { at, hooks, live } = hooksFor(t);
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() });
  hooks.start({ session_id: SID, source: 'startup' });
  assert.equal(await hooks.vigia({ session_id: SID }), null);
  assert.equal(fs.existsSync(at.layout(SID).vigia), false);
  at.deliverSync(SID, 'now it is used');
  at.claim(SID);
  const running = hooks.vigia({ session_id: SID });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(at.listening(SID).why, 'watch');
  assert.equal(fs.existsSync(at.layout(SID).vigia), true);
  live.set(SID, { alive: false, busy: false, startedAt: Date.now() });
  assert.equal(await running, null);
});

test('vigia: the next Stop\'s vigia takes over and this one leaves; so does it when the session is gone', async (t) => {
  const { at, hooks, live } = hooksFor(t);
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() });
  at.register(SID);
  const first = hooks.vigia({ session_id: SID });
  await new Promise((r) => setTimeout(r, 50));
  const second = hooks.vigia({ session_id: SID });
  assert.equal(await first, null);
  live.set(SID, { alive: false, busy: false, startedAt: Date.now() });
  assert.equal(await second, null);
});

test('prompt: what was waiting rides along as context, once', (t) => {
  const { at, hooks } = hooksFor(t);
  at.deliverSync(SID, 'also check the logs');
  const out = JSON.parse(hooks.prompt({ session_id: SID, prompt: 'run the tests' }).stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /^Messages for this session that were waiting \(ai-threads\):[\s\S]*\[Q1 · also check the logs\] also check the logs$/);
  assert.equal(hooks.prompt({ session_id: SID, prompt: 'again' }), null);
});

test('end: the session stops listening and its pending messages stay for when it comes back', (t) => {
  const { at, hooks, live } = hooksFor(t);
  live.set(SID, { alive: true, busy: false, startedAt: Date.now() - 1000 });
  hooks.start({ session_id: SID, source: 'startup' });
  at.deliverSync(SID, 'unread');
  assert.equal(at.listening(SID).listening, true);
  hooks.end({ session_id: SID, reason: 'prompt_input_exit' });
  assert.equal(at.listening(SID).listening, false);
  assert.equal(at.pending(SID).length, 1);
  assert.equal(at.events().pop().reason, 'prompt_input_exit');
});

test('the re-toucher rewrites the signal in place until nothing waits', async (t) => {
  const { at, hooks } = hooksFor(t);
  at.deliverSync(SID, 'x');
  const signal = at.layout(SID).signal;
  const ino = fs.statSync(signal, { bigint: true }).ino;
  const seen = new Set();
  const timer = setInterval(() => { try { seen.add(JSON.parse(fs.readFileSync(signal, 'utf8')).reason); } catch (_) { /* mid-write */ } }, 5);
  await hooks.touch(SID);
  clearInterval(timer);
  assert.ok(seen.has('retouch'));
  assert.equal(fs.statSync(signal, { bigint: true }).ino, ino);
  at.claim(SID);
  const before = fs.readFileSync(signal, 'utf8');
  await hooks.touch(SID);
  assert.equal(fs.readFileSync(signal, 'utf8'), before); // nothing waiting: no touch
});

test('runHook swallows errors into errors.log and does nothing', async (t) => {
  const root = tmp(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ transform: 'missing.js' }));
  fs.mkdirSync(path.join(home, 'sessions', SID), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', SID, 'session.json'), JSON.stringify({ session_id: SID }));
  const boom = () => { throw new Error('registry exploded'); };
  const r = await runHook('wake', { session_id: SID, file_path: 'x' }, { home, claudeDir: path.join(root, 'claude'), env: {}, liveness: boom });
  assert.deepEqual(r, { stdout: '', stderr: '', code: 0 });
  const v = await runHook('vigia', { session_id: SID }, { home, claudeDir: path.join(root, 'claude'), env: {}, liveness: boom, config: { vigia: { stepMs: 5, maxMs: 1000, aliveCheckMs: 1 } } });
  assert.deepEqual(v, { stdout: '', stderr: '', code: 0 });
  assert.match(fs.readFileSync(path.join(home, 'errors.log'), 'utf8'), /registry exploded/);
});

test('the real command line: start then wake, input on stdin, exit code 2 with the batch on stderr', (t) => {
  const root = tmp(t);
  const home = path.join(root, 'home');
  const bin = path.join(__dirname, '..', 'bin', 'ai-threads.js');
  const env = { ...process.env, AI_THREADS_HOME: '', CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const run = (args, input) => spawnSync(process.execPath, [bin, ...args, '--home', home, '#ai-threads'], { input, env, encoding: 'utf8' });
  const start = run(['hook', 'start'], JSON.stringify({ session_id: SID, source: 'startup' }));
  assert.equal(start.status, 0);
  const signal = JSON.parse(start.stdout).hookSpecificOutput.watchPaths[0];
  assert.equal(run(['send', SID, 'from the cli', '--title', 'CLI']).status, 0);
  const wake = run(['hook', 'wake'], JSON.stringify({ session_id: SID, file_path: signal }));
  assert.equal(wake.status, 2);
  assert.match(wake.stderr, /\[Q1 · CLI\] from the cli/);
  assert.equal(run(['hook', 'wake'], 'not json').status, 0);
});
