'use strict';
/*
 * Installs and removes the ai-threads hooks in a Claude Code settings file (the user's
 * <claude dir>/settings.json by default, or any settings file given).
 *
 *   SessionStart       node "<home>/runtime/bin/ai-threads.js" hook start  --home "<home>" #ai-threads
 *   FileChanged        ... hook wake    (asyncRewake)
 *   Stop               ... hook vigia   (asyncRewake, runs while the session is idle)
 *   UserPromptSubmit   ... hook prompt
 *   SessionEnd         ... hook end
 *
 * The hooks run from a copy of the package at <home>/runtime, so the settings keep working when the
 * package moves or updates (install again to refresh it). Every command ends with the tag "#ai-threads"
 * (a comment in a POSIX shell, an argument ai-threads ignores elsewhere), which is how our entries are
 * told apart. Our entries go after the user's own; nothing else is touched. The settings file is backed
 * up once, to <file>.ai-threads-backup, before the first change.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir: defaultClaudeDir } = require('../config');

const TAG = '#ai-threads';
const OURS = /ai-threads\.js"? hook (start|wake|vigia|prompt|end)\b.*#ai-threads$/;
const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const REWAKE = 'ai-threads: messages for this session.';
const REWAKE_SUMMARY = 'ai-threads: messages';

const settingsFile = ({ settings, claudeDir } = {}) => path.resolve(settings || path.join(defaultClaudeDir(claudeDir), 'settings.json'));
const runtimeDir = (home) => path.join(home, 'runtime');
const fwd = (p) => p.replace(/\\/g, '/');

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON, left untouched: ${e.message}`); }
}

const isOurs = (h) => !!h && typeof h.command === 'string' && OURS.test(h.command);

/**
 * Our five entries, for the runtime copy under `home`. `rewakeMessage` and `rewakeSummary` are the line
 * the session reads above a batch that woke it, and the short label Claude Code shows for it.
 */
function entries(home, { rewakeMessage = REWAKE, rewakeSummary = REWAKE_SUMMARY } = {}) {
  const bin = fwd(path.join(runtimeDir(home), 'bin', 'ai-threads.js'));
  const cmd = (ev) => `node "${bin}" hook ${ev} --home "${fwd(home)}" ${TAG}`;
  const rewake = { rewakeMessage, rewakeSummary };
  return {
    SessionStart: { hooks: [{ type: 'command', command: cmd('start'), timeout: 10 }] },
    FileChanged: { hooks: [{ type: 'command', command: cmd('wake'), asyncRewake: true, timeout: 30, ...rewake }] },
    Stop: { hooks: [{ type: 'command', command: cmd('vigia'), asyncRewake: true, timeout: 86400, ...rewake }] },
    UserPromptSubmit: { hooks: [{ type: 'command', command: cmd('prompt'), timeout: 10 }] },
    SessionEnd: { hooks: [{ type: 'command', command: cmd('end'), timeout: 10 }] },
  };
}

/** The rewake texts our installed entries carry now, so installing again without them keeps them. */
function currentRewake(settings) {
  for (const groups of Object.values((settings && settings.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      const h = g && Array.isArray(g.hooks) ? g.hooks.find((x) => isOurs(x) && typeof x.rewakeMessage === 'string') : null;
      if (h) return { rewakeMessage: h.rewakeMessage, rewakeSummary: typeof h.rewakeSummary === 'string' ? h.rewakeSummary : REWAKE_SUMMARY };
    }
  }
  return {};
}

/** The settings without our entries (groups left empty by that go too). */
function withoutHooks(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev]
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && !g.hooks.length));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

/**
 * The settings with our entries, exactly once, after the user's own. Rewake texts not given stay what
 * the installed entries had (else the defaults).
 */
function withHooks(settings, home, opts = {}) {
  const keep = currentRewake(settings);
  const pick = (k) => (typeof opts[k] === 'string' ? opts[k] : keep[k]);
  const rewake = {};
  for (const k of ['rewakeMessage', 'rewakeSummary']) if (pick(k) !== undefined) rewake[k] = pick(k);
  const s = withoutHooks(settings);
  s.hooks = s.hooks || {};
  for (const [ev, group] of Object.entries(entries(home, rewake))) s.hooks[ev] = [...(s.hooks[ev] || []), group];
  return s;
}

const isInstalled = (settings) => Object.values((settings && settings.hooks) || {})
  .some((groups) => Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)));

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function backupOnce(file) {
  const bak = `${file}.ai-threads-backup`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

/** Copies bin/, src/ and package.json to <home>/runtime, swapping the old copy out in one rename. */
function refreshRuntime(home, from = PACKAGE_ROOT) {
  const dest = runtimeDir(home);
  if (path.resolve(from) === path.resolve(dest)) return dest; // running from the copy itself
  const fresh = `${dest}.new-${process.pid}`;
  const old = `${dest}.old-${process.pid}`;
  fs.rmSync(fresh, { recursive: true, force: true });
  for (const part of ['bin', 'src']) fs.cpSync(path.join(from, part), path.join(fresh, part), { recursive: true });
  fs.copyFileSync(path.join(from, 'package.json'), path.join(fresh, 'package.json'));
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(fresh, dest);
  fs.rmSync(old, { recursive: true, force: true });
  return dest;
}

/**
 * Installs the hooks. `rewakeMessage` / `rewakeSummary`: the line above a batch that wakes the session and
 * its short label (kept from the installed entries when not given). Returns what it did.
 */
function install({ home, settings, claudeDir, rewakeMessage, rewakeSummary } = {}) {
  if (!home) throw new Error('install needs the ai-threads home');
  const file = settingsFile({ settings, claudeDir });
  const before = readSettings(file);
  const runtime = refreshRuntime(home);
  const after = withHooks(before, home, { rewakeMessage, rewakeSummary });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  let backup = null;
  if (changed) { backup = fs.existsSync(file) ? backupOnce(file) : null; write(file, after); }
  return { installed: true, changed, settings: file, runtime, backup };
}

/** Removes our entries. The runtime copy stays (harmless; `install` refreshes it). */
function remove({ settings, claudeDir } = {}) {
  const file = settingsFile({ settings, claudeDir });
  const before = readSettings(file);
  const after = withoutHooks(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) write(file, after);
  return { installed: false, changed, settings: file };
}

function status({ settings, claudeDir } = {}) {
  const file = settingsFile({ settings, claudeDir });
  let installed = false;
  let error = null;
  try { installed = isInstalled(readSettings(file)); } catch (e) { error = e.message; }
  return { installed, settings: file, error };
}

module.exports = { TAG, REWAKE, REWAKE_SUMMARY, settingsFile, runtimeDir, readSettings, entries, withHooks, withoutHooks, isInstalled, refreshRuntime, install, remove, status };
