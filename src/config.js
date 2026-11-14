'use strict';
/*
 * Where ai-threads keeps its files and what it reads from <home>/config.json.
 *
 *   home       AI_THREADS_HOME, else ~/.ai-threads (the hooks get it as --home from the installer)
 *   claudeDir  CLAUDE_CONFIG_DIR, else ~/.claude (only to tell which sessions are alive and find transcripts)
 */
const os = require('os');
const path = require('path');
const { readJson } = require('./util');

const DEFAULTS = Object.freeze({
  /** Who follows the session, in the instruction ("This session is followed in {app}"). */
  app: null,
  /** false: never tell the session about the Q markup; a string: a text of your own instead (another language, say). */
  instructions: true,
  /** Words besides `new` that open a thread (`[Q <word> · title]`), for an instruction of your own in another language. */
  newWords: [],
  /** Deliver only in sessions started by these entrypoints (CLAUDE_CODE_ENTRYPOINT), e.g. ['claude-vscode']. */
  entrypoints: null,
  /** Seconds between the re-touches after a session starts with messages waiting (its watcher comes up late). */
  touches: [4, 12, 30],
  /** The Stop vigia: how often it looks, how long it stays, how often it checks the session is alive. */
  vigia: { stepMs: 2000, maxMs: 23.5 * 3600 * 1000, aliveCheckMs: 60000 },
  /** Longest message accepted, in characters. */
  maxText: 20000,
  /** A module whose export transforms what a person writes before it is queued (translation, say). */
  transform: null,
  /** When a session ends: 'keep' its undelivered messages for when it comes back, or 'return' them. */
  onEnd: 'keep',
  /** The line above what rides along with a typed prompt; null: the default, '': none. */
  piggybackHeader: null,
  /** { command }: run detached after every claimed batch, the records as JSON on stdin (an app's delivered tick). */
  onDelivered: null,
  /** { command, everyMs }: run detached while a session sits idle (by its vigia) and on every touch (by wake). */
  tick: null,
});

/** How often the idle tick runs when `tick.everyMs` is not given. */
const TICK_EVERY_MS = 60000;

const homeDir = (home, env = process.env) => path.resolve(home || env.AI_THREADS_HOME || path.join(os.homedir(), '.ai-threads'));
const claudeDir = (dir, env = process.env) => path.resolve(dir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

function loadConfig(home, overrides = {}) {
  const file = readJson(path.join(home, 'config.json')) || {};
  const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => k in DEFAULTS && v !== undefined));
  const merged = { ...DEFAULTS, ...pick(file), ...pick(overrides) };
  merged.vigia = { ...DEFAULTS.vigia, ...(file.vigia || {}), ...(overrides.vigia || {}) };
  return merged;
}

module.exports = { DEFAULTS, TICK_EVERY_MS, homeDir, claudeDir, loadConfig };
