'use strict';
/* The Claude Code adapter: hooks, transcript reader, live-session registry and settings installer. */
const fs = require('fs');
const path = require('path');
const core = require('../core');
const { makeHooks, EVENTS, PIGGYBACK_HEADER } = require('./hooks');
const transcript = require('./transcript');
const sessions = require('./sessions');
const install = require('./install');

/**
 * Runs one hook the way Claude Code calls it and returns { stdout, stderr, code }. A hook never breaks
 * the session it runs in: an error is written to <home>/errors.log and the hook does nothing.
 */
async function runHook(event, input, { home, env = process.env, claudeDir, config, liveness, spawnToucher } = {}) {
  let api;
  try {
    api = core.open({ home, env, claudeDir, config, liveness, spawnToucher });
    const hooks = makeHooks(api, { env });
    if (!EVENTS.includes(event)) return { stdout: '', stderr: '', code: 0 };
    const res = await hooks[event](input || {});
    return { stdout: (res && res.stdout) || '', stderr: (res && res.stderr) || '', code: (res && res.code) || 0 };
  } catch (e) {
    try {
      const h = api ? api.home : core.open({ home, env }).home;
      fs.mkdirSync(h, { recursive: true });
      fs.appendFileSync(path.join(h, 'errors.log'), `${new Date().toISOString()} hook ${event}: ${e && e.stack ? e.stack : e}\n`);
    } catch (_) { /* nowhere to write */ }
    return { stdout: '', stderr: '', code: 0 };
  }
}

module.exports = { makeHooks, runHook, EVENTS, PIGGYBACK_HEADER, transcript, sessions, install };
