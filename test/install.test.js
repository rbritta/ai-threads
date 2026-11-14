'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const install = require('../src/claude-code/install');
const { tmp } = require('./helpers');

const userHooks = {
  model: 'opus',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'python my-start.py', timeout: 20 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python my-stop.py' }] }],
    FileChanged: [{ hooks: [{ type: 'command', command: 'node relay/hook.js wake #claude-session-relay', asyncRewake: true }] }],
  },
};

test('our five entries go after the user\'s own, exactly once, and come out cleanly', () => {
  const home = '/data/ai-threads';
  const once = install.withHooks(userHooks, home);
  const twice = install.withHooks(once, home);
  assert.deepEqual(twice, once);
  for (const ev of ['SessionStart', 'FileChanged', 'Stop', 'UserPromptSubmit', 'SessionEnd']) {
    const last = once.hooks[ev][once.hooks[ev].length - 1].hooks[0];
    assert.match(last.command, /^node "\/data\/ai-threads\/runtime\/bin\/ai-threads\.js" hook (start|wake|vigia|prompt|end) --home "\/data\/ai-threads" #ai-threads$/);
  }
  assert.equal(once.hooks.SessionStart[0].hooks[0].command, 'python my-start.py');
  assert.equal(once.hooks.FileChanged[1].hooks[0].asyncRewake, true);
  assert.equal(once.hooks.Stop[1].hooks[0].asyncRewake, true);
  assert.equal(once.hooks.Stop[1].hooks[0].timeout, 86400);
  assert.deepEqual(install.withoutHooks(once), userHooks);
  assert.equal(install.isInstalled(once), true);
  assert.equal(install.isInstalled(userHooks), false);
});

test('install writes the settings once with a backup, copies the runtime, and remove leaves the rest', (t) => {
  const root = tmp(t);
  const home = path.join(root, 'home');
  const settings = path.join(root, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(userHooks));
  const r = install.install({ home, settings });
  assert.equal(r.changed, true);
  assert.ok(fs.existsSync(`${settings}.ai-threads-backup`));
  assert.ok(fs.existsSync(path.join(home, 'runtime', 'bin', 'ai-threads.js')));
  assert.ok(fs.existsSync(path.join(home, 'runtime', 'src', 'claude-code', 'hooks.js')));
  assert.ok(fs.existsSync(path.join(home, 'runtime', 'package.json')));
  assert.equal(install.install({ home, settings }).changed, false);
  assert.equal(install.status({ settings }).installed, true);
  fs.writeFileSync(`${settings}.ai-threads-backup`, 'keep me');
  install.install({ home, settings });
  assert.equal(fs.readFileSync(`${settings}.ai-threads-backup`, 'utf8'), 'keep me'); // backed up once only
  assert.equal(install.remove({ settings }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), userHooks);
  assert.equal(install.remove({ settings }).changed, false);
});

test('a settings file that is not JSON is left untouched', (t) => {
  const root = tmp(t);
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, '{ broken');
  assert.throws(() => install.install({ home: path.join(root, 'home'), settings }), /not valid JSON/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
  assert.match(install.status({ settings }).error, /not valid JSON/);
});

test('the default settings file is <claude dir>/settings.json', (t) => {
  const root = tmp(t);
  assert.equal(install.settingsFile({ claudeDir: root }), path.join(root, 'settings.json'));
});

test('the runtime copy runs the hooks on its own', (t) => {
  const root = tmp(t);
  const home = path.join(root, 'home');
  install.install({ home, settings: path.join(root, 'settings.json') });
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(home, 'runtime', 'bin', 'ai-threads.js'), 'hook', 'start', '--home', home, '#ai-threads'], {
    input: JSON.stringify({ session_id: 'abc-1', source: 'startup' }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.watchPaths, [path.join(home, 'sessions', 'abc-1', 'signal')]);
});
