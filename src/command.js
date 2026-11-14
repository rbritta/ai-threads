'use strict';
/*
 * The commands an app configures to hear from ai-threads (`onDelivered`, `tick`): run detached, never
 * waited on, with a JSON payload on stdin and output ignored. A hook exits right after, so the payload
 * goes through a file the child gets as its stdin, not a pipe that could still be filling when the hook
 * process ends.
 *
 *   { "command": ["python", "/path/app.py", "delivered"] }   argv, no shell
 *   { "command": "python /path/app.py delivered" }            one line, through the shell
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { newId } = require('./util');

const STALE_MS = 60 * 60 * 1000;

/** True when `spec` names something to run. */
const runnable = (spec) => !!spec && (typeof spec.command === 'string' ? !!spec.command.trim() : Array.isArray(spec.command) && spec.command.length > 0);

/** Payload files whose child never took them (an unlink refused on Windows): gone after an hour. */
function sweep(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > STALE_MS) fs.unlinkSync(f); } catch (_) { /* in use or gone */ }
  }
}

/** Starts `spec.command` detached with `payload` as JSON on its stdin. False when there is nothing to run. */
function runDetached(home, spec, payload, { now = Date.now() } = {}) {
  if (!runnable(spec)) return false;
  const dir = path.join(home, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  sweep(dir, now);
  const file = path.join(dir, `payload-${process.pid}-${newId(now)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  const fd = fs.openSync(file, 'r');
  try {
    const shell = typeof spec.command === 'string';
    const [exe, ...args] = shell ? [spec.command] : spec.command.map(String);
    const child = spawn(exe, args, {
      detached: true, shell, windowsHide: true, stdio: [fd, 'ignore', 'ignore'],
      env: { ...process.env, AI_THREADS_HOME: home },
    });
    child.on('error', () => { /* a command that does not exist: nobody is listening */ });
    child.unref();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch (_) { /* the child still holds it; the sweep takes it later */ }
  }
  return true;
}

module.exports = { runnable, runDetached };
