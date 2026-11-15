'use strict';
/*
 * A file system in memory, with the synchronous calls the library makes: enough for ai-threads' real
 * code to keep its inbox, registry, delivered records and a session's transcript in a browser tab.
 * Errors carry Node's codes (ENOENT, EEXIST...), since the library decides by them.
 *
 * Two extras for the demo: `watch(file, listener)` calls back after every write to the file (Claude
 * Code's file watch on the signal), and `list()` returns every file with its size.
 */
const path = require('path');
const { Buffer } = require('buffer');

const files = new Map(); // absolute path -> { data: Uint8Array, mtimeMs }
const dirs = new Set(['/']);
const handles = new Map(); // fd -> path
const watchers = new Map(); // path -> Set of listeners
let nextFd = 3;

const abs = (p) => path.resolve(String(p));
const fail = (code, syscall, p) => Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: p });
const bytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));

function changed(p) {
  const set = watchers.get(p);
  if (set) for (const fn of set) setTimeout(() => fn('change', path.basename(p)), 0);
}

function parentOf(p, syscall) {
  if (!dirs.has(path.dirname(p))) throw fail('ENOENT', syscall, p);
}

function existsSync(p) {
  const a = abs(p);
  return files.has(a) || dirs.has(a);
}

function mkdirSync(p, { recursive = false } = {}) {
  const a = abs(p);
  if (dirs.has(a)) {
    if (recursive) return undefined;
    throw fail('EEXIST', 'mkdir', a);
  }
  if (files.has(a)) throw fail('EEXIST', 'mkdir', a);
  if (!dirs.has(path.dirname(a))) {
    if (!recursive) throw fail('ENOENT', 'mkdir', a);
    mkdirSync(path.dirname(a), { recursive: true });
  }
  dirs.add(a);
  return a;
}

function writeFileSync(p, data, options) {
  const a = abs(p);
  const flag = (options && typeof options === 'object' && options.flag) || 'w';
  parentOf(a, 'open');
  if (dirs.has(a)) throw fail('EISDIR', 'open', a);
  if (flag.includes('x') && files.has(a)) throw fail('EEXIST', 'open', a);
  let next = bytes(data);
  if (flag.startsWith('a') && files.has(a)) {
    const before = files.get(a).data;
    const joined = new Uint8Array(before.length + next.length);
    joined.set(before);
    joined.set(next, before.length);
    next = joined;
  }
  files.set(a, { data: next, mtimeMs: Date.now() });
  changed(a);
}

const appendFileSync = (p, data) => writeFileSync(p, data, { flag: 'a' });

function readFileSync(p, options) {
  const a = abs(p);
  const f = files.get(a);
  if (!f) throw fail(dirs.has(a) ? 'EISDIR' : 'ENOENT', 'open', a);
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  const b = Buffer.from(f.data);
  return encoding ? b.toString(encoding) : b;
}

function renameSync(from, to) {
  const a = abs(from);
  const b = abs(to);
  const f = files.get(a);
  if (!f) throw fail('ENOENT', 'rename', a);
  parentOf(b, 'rename');
  files.delete(a);
  files.set(b, f);
  changed(b);
}

function unlinkSync(p) {
  const a = abs(p);
  if (!files.delete(a)) throw fail('ENOENT', 'unlink', a);
}

function statSync(p) {
  const a = abs(p);
  const f = files.get(a);
  if (f) return { size: f.data.length, mtimeMs: f.mtimeMs, isFile: () => true, isDirectory: () => false };
  if (dirs.has(a)) return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
  throw fail('ENOENT', 'stat', a);
}

function readdirSync(p) {
  const a = abs(p);
  if (!dirs.has(a)) throw fail('ENOENT', 'scandir', a);
  const names = new Set();
  for (const q of [...files.keys(), ...dirs]) {
    if (q !== a && path.dirname(q) === a) names.add(path.basename(q));
  }
  return [...names].sort();
}

function openSync(p, flags = 'r') {
  const a = abs(p);
  if (flags === 'r') {
    if (!files.has(a)) throw fail('ENOENT', 'open', a);
  } else {
    parentOf(a, 'open');
    if (flags.includes('x') && files.has(a)) throw fail('EEXIST', 'open', a);
    if (flags.startsWith('w') || !files.has(a)) files.set(a, { data: new Uint8Array(0), mtimeMs: Date.now() });
  }
  const fd = nextFd++;
  handles.set(fd, a);
  return fd;
}

function writeSync(fd, data) {
  const a = handles.get(fd);
  if (!a) throw fail('EBADF', 'write', String(fd));
  appendFileSync(a, data);
  return bytes(data).length;
}

function readSync(fd, buffer, offset, length, position) {
  const a = handles.get(fd);
  const f = a && files.get(a);
  if (!f) throw fail('EBADF', 'read', String(fd));
  const part = f.data.subarray(position, position + length);
  buffer.set(part, offset);
  return part.length;
}

function closeSync(fd) {
  handles.delete(fd);
}

/** Calls `listener('change', name)` after every write to `p`; returns `{ close() }`. */
function watch(p, listener) {
  const a = abs(p);
  if (!watchers.has(a)) watchers.set(a, new Set());
  watchers.get(a).add(listener);
  return { close: () => watchers.get(a).delete(listener) };
}

/** Every file, sorted by path: `[{ path, size }]`. */
const list = () => [...files.entries()].map(([p, f]) => ({ path: p, size: f.data.length })).sort((x, y) => (x.path < y.path ? -1 : 1));

module.exports = {
  existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync, statSync, readdirSync,
  openSync, writeSync, readSync, closeSync, watch, list,
};
