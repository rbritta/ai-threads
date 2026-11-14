'use strict';
/*
 * The thread registry of one session: <session dir>/threads.json. It holds what a thread is (number,
 * title, who opened it, type, red flag, release keys, an app's own id, parent, status); the messages live in the inbox,
 * the delivered records, the session's transcript and messages.jsonl.
 *
 * Every change goes through `update`, which holds <session dir>/state/threads.lock while it reads,
 * changes and rewrites the file, so two processes never number two threads the same.
 */
const path = require('path');
const { readJson, writeAtomic, withLock, iso } = require('./util');
const { threadId } = require('./markup');

const FILE = 'threads.json';
const empty = () => ({ v: 1, threads: [] });

function load(dir) {
  const r = readJson(path.join(dir, FILE));
  return r && Array.isArray(r.threads) ? r : empty();
}

function update(dir, fn) {
  return withLock(path.join(dir, 'state', 'threads.lock'), () => {
    const r = load(dir);
    const out = fn(r);
    writeAtomic(path.join(dir, FILE), r);
    return out;
  });
}

const find = (r, n) => r.threads.find((t) => t.n === n) || null;
const byKey = (r, key) => r.threads.find((t) => t.key === key) || null;
/** The thread an app knows by its own id (`ref`): one of its conversations, say. */
const byRef = (r, ref) => (ref == null || ref === '' ? null : r.threads.find((t) => t.ref != null && String(t.ref) === String(ref)) || null);
const nextN = (r) => Math.max(0, ...r.threads.map((t) => t.n)) + 1;

/** A new thread with every field the protocol lists. `n` defaults to the next free number. */
function make(r, fields = {}) {
  const n = fields.n || nextN(r);
  const t = {
    id: threadId(n), n, title: '', title_by: null, title_at: null,
    type: null, alert: false, release: null,
    opened_by: 'person', key: null, ref: null, parent: null,
    at: iso(), status: 'open', resolved_at: null, resolved_by: null,
    ...fields,
  };
  t.n = n;
  t.id = threadId(n);
  r.threads.push(t);
  r.threads.sort((a, b) => a.n - b.n);
  return t;
}

/** Thread `n`, made when the registry does not know it yet (a number seen in a transcript, say). */
const ensure = (r, n, fields = {}) => find(r, n) || make(r, { ...fields, n });

module.exports = { FILE, empty, load, update, find, byKey, byRef, nextN, make, ensure };
