'use strict';
/*
 * Which Claude Code sessions are alive and which are mid-turn, from the registry Claude Code keeps at
 * <claude dir>/sessions/<pid>.json ({ sessionId, pid, status, startedAt, cwd, ... }). Read only.
 */
const fs = require('fs');
const path = require('path');
const { readJson, pidAlive } = require('../util');

/** Every entry of the registry, with `alive` from its pid. */
function entries(claudeDir) {
  const dir = path.join(claudeDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch (_) { return []; }
  return names.map((f) => readJson(path.join(dir, f))).filter((s) => s && s.sessionId).map((s) => ({ ...s, alive: pidAlive(s.pid) }));
}

/**
 * A function from a session id to { known, alive, busy, startedAt, pid, cwd }. When a session appears
 * more than once (it was resumed), the live entry wins, then the newest.
 */
function liveness(claudeDir, { cacheMs = 1000 } = {}) {
  let cache = null;
  let at = 0;
  return (sid) => {
    if (!cache || Date.now() - at > cacheMs) { cache = entries(claudeDir); at = Date.now(); }
    const mine = cache.filter((s) => s.sessionId === sid).sort((a, b) => (b.alive - a.alive) || ((b.startedAt || 0) - (a.startedAt || 0)));
    const s = mine[0];
    if (!s) return { known: false, alive: false, busy: false, startedAt: null };
    return { known: true, alive: s.alive, busy: s.alive && s.status === 'busy', startedAt: s.startedAt || null, pid: s.pid, cwd: s.cwd || null };
  };
}

module.exports = { entries, liveness };
