'use strict';
/*
 * Small file helpers shared by the core and the hooks. Everything here is synchronous: hooks are short
 * processes, and a write that has returned is a write another process can already see.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** A session id we accept: what Claude Code uses (a UUID) or any short name without path separators. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const validSession = (sid) => SESSION_ID.test(String(sid || '')) && !String(sid).includes('..');

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.ceil(ms));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** Retries a rename that Windows refuses while another process has the target open for a moment. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(10 + i * 5);
    }
  }
}

/**
 * Writes a file whole or not at all: a temp file in the same folder (its name starts with a dot, so
 * listings skip it), then a rename over the target.
 */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, typeof data === 'string' ? data : `${JSON.stringify(data, null, 1)}\n`);
  try { renameRetry(tmp, file); } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
    throw e;
  }
}

/** One JSON line appended (a single write: small lines from several processes do not interleave). */
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a torn line */ }
  }
  return out;
}

/**
 * Runs `fn` holding an exclusive lock file. Waits up to `waitMs` for another holder; a lock older than
 * `staleMs` belongs to a process that died and is broken.
 */
function withLock(file, fn, { waitMs = 3000, staleMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  let fd;
  for (;;) {
    try { fd = fs.openSync(file, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
      } catch (_) { continue; } // released meanwhile
      if (Date.now() > until) throw Object.assign(new Error(`lock busy: ${file}`), { code: 'ELOCKED' });
      sleepSync(10 + Math.random() * 20);
    }
  }
  try {
    try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return fn();
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* broken as stale by someone else */ }
  }
}

/** Sortable message id: the time in base 36, then randomness. Names sort in the order they were written. */
function newId(now = Date.now()) {
  return `${now.toString(36).padStart(9, '0')}-${crypto.randomBytes(4).toString('hex')}`;
}

const iso = (t = Date.now()) => new Date(t).toISOString();

function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => {
    const v = path.resolve(String(p)).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? v.toLowerCase() : v;
  };
  return n(a) === n(b);
}

/** The JSON files of a folder, oldest name first, skipping temp files (they start with a dot). */
function jsonFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch (_) { return []; }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(+pid) || +pid <= 0) return false;
  try { process.kill(+pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

module.exports = {
  SESSION_ID, validSession, sleepSync, sleep, readJson, writeAtomic, renameRetry, appendJsonl, readJsonl, withLock,
  newId, iso, samePath, jsonFiles, pidAlive,
};
