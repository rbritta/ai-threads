'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main, parse } = require('../src/cli');
const { SID, SID2, tmp } = require('./helpers');

function cli(t) {
  const root = tmp(t);
  const home = path.join(root, 'home');
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const run = async (args, stdin = '') => {
    let out = '';
    let err = '';
    const code = await main([...args, '--home', home], { stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, stdin: () => stdin, env });
    return { code, out, err, json: () => JSON.parse(out) };
  };
  return { root, home, run };
}

test('parse: flags with and without values, booleans, the installer tag ignored', () => {
  assert.deepEqual(parse(['send', 's1', 'hi', 'there', '--thread', '2', '--alert', '--title=T', '#ai-threads']), {
    _: ['send', 's1', 'hi', 'there'], f: { thread: '2', alert: true, title: 'T' },
  });
});

test('send from words, a file or stdin; list shows what waits', async (t) => {
  const { root, run } = cli(t);
  assert.match((await run(['send', SID, 'Is', 'it', 'fixed?'])).out, /^queued \S+ in q1\n$/);
  const f = path.join(root, 'msg.txt');
  fs.writeFileSync(f, 'From a "file" with $quotes');
  const r = await run(['send', SID, '--file', f, '--thread', '1', '--json']);
  assert.equal(r.json().thread, 'q1');
  await run(['send', SID, '-', '--notice'], 'from stdin');
  const list = (await run(['list', SID, '--json'])).json();
  assert.deepEqual(list.map((m) => [m.thread, m.kind, m.text]), [['q1', 'turn', 'Is it fixed?'], ['q1', 'turn', 'From a "file" with $quotes'], [null, 'notice', 'from stdin']]);
  assert.match((await run(['list'])).out, /Is it fixed\?/);
});

test('threads, rename, resolve, reopen, view', async (t) => {
  const { run } = cli(t);
  await run(['send', SID, 'one']);
  await run(['rename', SID, '1', 'Better', 'title']);
  await run(['resolve', SID, '1']);
  assert.match((await run(['threads', SID])).out, /^Q1 {2}resolved {2}Better title\n$/);
  await run(['reopen', SID, '1']);
  const v = (await run(['view', SID])).json();
  assert.deepEqual([v.threads[0].title, v.threads[0].status, v.threads[0].state], ['Better title', 'open', 'queued']);
});

test('open an ask by the session, answer it, read the answer back', async (t) => {
  const { root, run } = cli(t);
  const f = path.join(root, 'ask.txt');
  fs.writeFileSync(f, 'May I push v1.2?');
  assert.equal((await run(['open', SID, '--file', f, '--title', 'Push?', '--type', 'authorization', '--alert', '--release', 'git'])).out, 'opened Q1\n');
  await run(['send', SID, 'yes', '--thread', '1']);
  const a = (await run(['answers', SID, '--release', 'git', '--json'])).json();
  assert.deepEqual(a.map((x) => [x.thread, x.release, x.text]), [['q1', 'git', 'yes']]);
});

test('retract, handback, register, events, status', async (t) => {
  const { run } = cli(t);
  const id = (await run(['send', SID, 'oops', '--json'])).json().id;
  assert.equal((await run(['retract', SID, id])).out, 'retracted\n');
  assert.equal((await run(['retract', SID, id])).code, 1);
  await run(['send', SID, 'for the next one']);
  assert.equal((await run(['handback', SID, '--to', SID2])).out, `1 handed back to ${SID2}\n`);
  assert.equal((await run(['register', SID2, '--app', 'the Dev app', '--lang', 'pt', '--instructed'])).json().lang, 'pt');
  const ev = (await run(['events', '--session', SID, '--json'])).json().map((e) => e.event);
  assert.deepEqual(ev, ['queued', 'retracted', 'queued', 'handed_back']);
  const st = (await run(['status', '--json'])).json();
  assert.equal(st.hooks.installed, false);
  assert.deepEqual(st.sessions.map((s) => [s.session_id, s.pending, s.listening]).sort(), [[SID, 0, false], [SID2, 1, false]].sort());
});

test('install and remove against a given settings file', async (t) => {
  const { root, home, run } = cli(t);
  const settings = path.join(root, 'project', '.claude', 'settings.local.json');
  assert.match((await run(['install', '--settings', settings])).out, /^installed in /);
  assert.ok(fs.existsSync(path.join(home, 'runtime', 'bin', 'ai-threads.js')));
  assert.match((await run(['install', '--settings', settings])).out, /^already installed/);
  assert.equal((await run(['status', '--settings', settings, '--json'])).json().hooks.installed, true);
  assert.match((await run(['remove', '--settings', settings])).out, /^removed from /);
});

test('errors: an unknown command, an empty message, a bad session', async (t) => {
  const { run } = cli(t);
  assert.equal((await run(['nope'])).code, 2);
  const empty = await run(['send', SID, '']);
  assert.deepEqual([empty.code, /empty message/.test(empty.err)], [1, true]);
  assert.match((await run(['send', '../x', 'hi'])).err, /not a session id/);
  assert.match((await run(['help'])).out, /^ai-threads: threads between/);
});
