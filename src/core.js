'use strict';
/*
 * The inbox of each session and the threads in it. `open()` returns the API an app, a router or the
 * hooks use; every piece of state is a file under <home>/sessions/<session id>/ (docs/PROTOCOL.md),
 * so another program, in any language, can read and write the same files.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const util = require('./util');
const markup = require('./markup');
const registry = require('./registry');
const command = require('./command');
const { homeDir, claudeDir, loadConfig, TICK_EVERY_MS } = require('./config');

const { validSession, readJson, writeAtomic, renameRetry, appendJsonl, readJsonl, withLock, newId, iso, jsonFiles } = util;
const BIN = path.join(__dirname, '..', 'bin', 'ai-threads.js');

/** The files of one session. */
function layout(home, sid) {
  const dir = path.join(home, 'sessions', sid);
  return {
    dir,
    inbox: path.join(dir, 'inbox'),
    delivered: path.join(dir, 'delivered'),
    retracted: path.join(dir, 'retracted'),
    signal: path.join(dir, 'signal'),
    session: path.join(dir, 'session.json'),
    log: path.join(dir, 'messages.jsonl'),
    answers: path.join(dir, 'answers.jsonl'),
    state: path.join(dir, 'state'),
    armed: path.join(dir, 'state', 'armed.json'),
    vigia: path.join(dir, 'state', 'vigia'),
    instructed: path.join(dir, 'state', 'instructed'),
    tick: path.join(dir, 'state', 'tick'),
    claimLock: path.join(dir, 'state', 'claim.lock'),
  };
}

/** One release key, or several (one ask that allows more than one thing): a string, a list, or null. */
function releaseKeys(v) {
  if (Array.isArray(v)) {
    const keys = [...new Set(v.map((k) => String(k == null ? '' : k).trim()).filter(Boolean))];
    return keys.length > 1 ? keys : keys[0] || null;
  }
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

/** Whether an answer's release (a key or a list of keys) covers `key`. */
const releases = (value, key) => (Array.isArray(value) ? value.includes(key) : value === key);

function open(options = {}) {
  const env = options.env || process.env;
  const home = homeDir(options.home, env);
  const config = loadConfig(home, options.config || {});
  const claude = claudeDir(options.claudeDir, env);
  const now = options.now || (() => Date.now());
  const liveness = options.liveness || require('./claude-code/sessions').liveness(claude);
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const spawnToucher = options.spawnToucher || ((sid) => {
    spawn(process.execPath, [BIN, 'touch', sid, '--home', home], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  /** Runs a configured command ({ command }) detached with `payload` on stdin; tests pass their own. */
  const runCommand = options.runCommand || ((spec, payload) => command.runDetached(home, spec, payload, { now: now() }));
  const eventsFile = path.join(home, 'events.jsonl');

  const L = (sid) => {
    if (!validSession(sid)) throw Object.assign(new Error(`not a session id: ${sid}`), { code: 'EBADSESSION' });
    return layout(home, String(sid));
  };

  function event(type, sid, fields = {}) {
    const e = { at: iso(now()), event: type, session_id: sid, ...fields };
    try { appendJsonl(eventsFile, e); } catch (_) { /* events are a courtesy; delivery never fails over them */ }
    if (onEvent) { try { onEvent(e); } catch (_) { /* the app's callback is its own */ } }
    return e;
  }

  /** The session's folders and its signal file. The signal is created once and never removed. */
  function ensureSession(sid) {
    const p = L(sid);
    for (const d of [p.inbox, p.delivered, p.state]) fs.mkdirSync(d, { recursive: true });
    try { fs.writeFileSync(p.signal, JSON.stringify({ at: iso(now()), reason: 'created' }), { flag: 'wx' }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    return p;
  }

  /**
   * Rewrites the signal file in place. Claude Code keeps one file watcher per session, shared by every
   * tool that asked for one, and a watched file that is removed or renamed can take it down for all of
   * them: the signal is only ever overwritten.
   */
  function touch(sid, reason = 'touch') {
    const p = ensureSession(sid);
    fs.writeFileSync(p.signal, JSON.stringify({ at: iso(now()), reason, pending: jsonFiles(p.inbox).length }));
    return p.signal;
  }

  const session = (sid) => readJson(L(sid).session) || {};

  /** True when the session was registered or was ever sent a message. */
  function known(sid) {
    if (!validSession(sid)) return false;
    const p = L(sid);
    return fs.existsSync(p.session) || jsonFiles(p.inbox).length > 0 || jsonFiles(p.delivered).length > 0;
  }

  function register(sid, fields = {}) {
    const p = ensureSession(sid);
    const cur = readJson(p.session) || { session_id: sid, created_at: iso(now()) };
    const next = { ...cur, ...fields, session_id: sid, updated_at: iso(now()) };
    writeAtomic(p.session, next);
    return next;
  }

  // ── sending ────────────────────────────────────────────────────────────────

  /**
   * Queues a message for the session and touches its signal. Synchronous; `deliver` runs the
   * configured transform first.
   *
   * opts.thread  3 or 'q3' (made if unknown, reopened if resolved); omitted: a new thread; false: no thread
   * opts.ref     an app's own id for the thread (one of its conversations): with no `thread`, the message
   *              goes to the thread that has this ref, or opens one that keeps it
   * opts.kind    'turn' (default) or 'notice' (no reply expected, never in a thread)
   * opts.title, opts.type, opts.alert, opts.release (a key or a list), opts.parent: for a new thread
   * opts.from    who wrote it: 'person' (default), 'app', or a name
   * opts.footer  a closing paragraph; a batch prints each distinct footer once, after its messages
   * opts.meta    anything the sender wants back in the delivered record
   * opts.retouch also re-touch a few times from a detached process (a session that is just starting)
   */
  function deliverSync(sid, text, opts = {}) {
    const p = ensureSession(sid);
    const body = String(text == null ? '' : text).trim();
    if (!body) throw Object.assign(new Error('empty message'), { code: 'EEMPTY' });
    if (body.length > config.maxText) throw Object.assign(new Error(`message longer than ${config.maxText} characters`), { code: 'ETOOLONG' });
    const kind = opts.kind === 'notice' ? 'notice' : 'turn';
    const from = opts.from || 'person';
    const ref = opts.ref == null || String(opts.ref).trim() === '' ? null : String(opts.ref).trim();
    let thread = null;
    if (kind === 'turn' && opts.thread !== false) {
      const n = markup.threadNumber(opts.thread);
      if (opts.thread != null && opts.thread !== '' && !n) throw Object.assign(new Error(`not a thread: ${opts.thread}`), { code: 'EBADTHREAD' });
      const parent = markup.threadNumber(opts.parent);
      thread = registry.update(p.dir, (r) => {
        let t = n ? registry.find(r, n) : (ref ? registry.byRef(r, ref) : null);
        if (!t) {
          t = registry.make(r, {
            n: n || undefined,
            title: markup.oneLine(opts.title || (n ? '' : markup.titleOf(body)), 90),
            title_by: opts.title ? (from === 'person' ? 'person' : 'app') : null,
            opened_by: from === 'person' ? 'person' : 'app',
            type: opts.type || null, alert: !!opts.alert, release: releaseKeys(opts.release),
            ref, parent: parent && registry.find(r, parent) ? markup.threadId(parent) : null,
            at: iso(now()),
          });
        } else if (t.status === 'resolved') {
          Object.assign(t, { status: 'open', resolved_at: null, resolved_by: null });
        }
        return { ...t };
      });
    }
    const msg = { v: 1, id: newId(now()), session_id: sid, thread: thread ? thread.id : null, kind, from, text: body, meta: opts.meta || {}, at: iso(now()) };
    if (opts.original != null && String(opts.original).trim() !== body) msg.original = String(opts.original);
    if (opts.footer != null && String(opts.footer).trim()) msg.footer = String(opts.footer).trim();
    writeAtomic(path.join(p.inbox, `${msg.id}.json`), msg);
    if (thread && thread.release && from === 'person') {
      appendJsonl(p.answers, { at: msg.at, session_id: sid, thread: thread.id, release: thread.release, text: body, id: msg.id });
    }
    event('queued', sid, { id: msg.id, thread: msg.thread, kind, from });
    touch(sid, 'message');
    if (opts.retouch) spawnToucher(sid);
    return { id: msg.id, thread: msg.thread, n: thread ? thread.n : null };
  }

  /** deliverSync after the transform (options.transform, else config.transform), keeping the original. */
  async function deliver(sid, text, opts = {}) {
    const fn = opts.transform === false ? null : (opts.transform || options.transform || loadTransform());
    if (!fn) return deliverSync(sid, text, opts);
    const original = String(text == null ? '' : text);
    const out = await fn(original, { session_id: sid, thread: opts.thread ?? null, from: opts.from || 'person' });
    return deliverSync(sid, out == null || !String(out).trim() ? original : out, { ...opts, original });
  }

  let transformMod;
  function loadTransform() {
    if (transformMod !== undefined) return transformMod;
    transformMod = null;
    if (config.transform) {
      const mod = require(path.resolve(home, config.transform));
      transformMod = typeof mod === 'function' ? mod : mod.transform || null;
    }
    return transformMod;
  }

  const notice = (sid, text, opts = {}) => deliverSync(sid, text, { ...opts, kind: 'notice' });

  // ── delivering ─────────────────────────────────────────────────────────────

  const pending = (sid) => {
    if (!validSession(sid)) return [];
    return jsonFiles(L(sid).inbox).map((f) => readJson(path.join(L(sid).inbox, f))).filter(Boolean);
  };

  /**
   * Takes every pending message of the session, oldest first. Each is claimed by renaming it into
   * delivered/ (one rename wins), then rewritten there with delivered_at, session_id and via. The
   * session's claim lock keeps a batch whole when two hooks fire at once.
   */
  function claim(sid, { via = 'api' } = {}) {
    if (!validSession(sid)) return [];
    const p = L(sid);
    if (!fs.existsSync(p.inbox) || !jsonFiles(p.inbox).length) return [];
    let batch;
    try {
      batch = withLock(p.claimLock, () => {
        const out = [];
        fs.mkdirSync(p.delivered, { recursive: true });
        for (const name of jsonFiles(p.inbox)) {
          const to = path.join(p.delivered, name);
          try { renameRetry(path.join(p.inbox, name), to); } catch (_) { continue; } // taken
          const m = readJson(to) || { v: 1, id: name.slice(0, -5), thread: null, kind: 'turn', text: '' };
          Object.assign(m, { delivered_at: iso(now()), session_id: sid, via });
          writeAtomic(to, m);
          event('delivered', sid, { id: m.id, thread: m.thread, kind: m.kind, via });
          out.push(m);
        }
        return out;
      }, { waitMs: 4000 });
    } catch (e) {
      if (e.code === 'ELOCKED') return []; // the holder is delivering them
      throw e;
    }
    if (batch.length && command.runnable(config.onDelivered)) {
      try { runCommand(config.onDelivered, { event: 'delivered', session_id: sid, via, messages: batch }); } catch (_) { /* delivery never fails over the app's command */ }
    }
    return batch;
  }

  /**
   * The idle tick (config.tick): runs its command detached with the session id. `throttle` (the vigia)
   * runs it only when `everyMs` passed since the last tick of the session; the wake runs it every time.
   */
  function tick(sid, { via = 'api', throttle = false } = {}) {
    if (!command.runnable(config.tick) || !validSession(sid)) return false;
    const p = L(sid);
    const every = Number(config.tick.everyMs) > 0 ? Number(config.tick.everyMs) : TICK_EVERY_MS;
    if (throttle) {
      const last = Number((readJson(p.tick) || {}).at_ms) || 0;
      if (last && now() - last < every) return false;
    }
    try {
      fs.mkdirSync(p.state, { recursive: true });
      writeAtomic(p.tick, { at: iso(now()), at_ms: now(), via });
      runCommand(config.tick, { event: 'tick', session_id: sid, via });
    } catch (_) { return false; }
    return true;
  }

  function instructionText(sid) {
    const s = session(sid);
    if (config.instructions === false || s.instruction === false) return null;
    const custom = typeof s.instruction === 'string' ? s.instruction : typeof config.instructions === 'string' ? config.instructions : null;
    return markup.instruction({ app: s.app || config.app, custom });
  }
  const instructed = (sid) => fs.existsSync(L(sid).instructed) || session(sid).instructed === true;

  /**
   * The text the session reads for a claimed batch: each message with its thread's mark, notices as
   * they are, then each distinct footer once, in the order first seen. The first batch with a thread in
   * a session also carries the instruction, once.
   */
  function formatDelivery(sid, msgs, { instruct = true } = {}) {
    const reg = registry.load(L(sid).dir);
    const items = msgs.map((m) => {
      const n = m.kind !== 'notice' ? markup.threadNumber(m.thread) : null;
      return n ? { n, title: (registry.find(reg, n) || {}).title || '', text: m.text } : { text: m.text };
    });
    let text = markup.formatBatch(items);
    const footers = [...new Set(msgs.map((m) => (typeof m.footer === 'string' ? m.footer.trim() : '')).filter(Boolean))];
    if (footers.length) text = `${text}\n\n${footers.join('\n\n')}`;
    if (instruct && items.some((i) => i.n) && !instructed(sid)) {
      const ins = instructionText(sid);
      if (ins) {
        text = `${ins}\n\n${text}`;
        try { fs.mkdirSync(L(sid).state, { recursive: true }); fs.writeFileSync(L(sid).instructed, iso(now())); } catch (_) { /* told again next time */ }
      }
    }
    return text;
  }

  /** What the session should be reminded of when its context starts over (resume, clear, compact). */
  const reminder = (sid) => (instructed(sid) ? instructionText(sid) : null);

  function delivered(sid, { since } = {}) {
    if (!validSession(sid)) return [];
    const p = L(sid);
    const all = jsonFiles(p.delivered).map((f) => readJson(path.join(p.delivered, f))).filter(Boolean);
    return since ? all.filter((m) => String(m.delivered_at || '') >= String(since)) : all;
  }

  /**
   * Takes back a message still pending (the person removed it, or an app routes it elsewhere): one rename
   * into retracted/ under the claim lock, the record then gains retracted_at (and reason). True when it
   * was still there.
   */
  function retract(sid, id, { reason = null } = {}) {
    const p = L(sid);
    if (!/^[\w-]+$/.test(String(id || ''))) return false;
    return withLock(p.claimLock, () => {
      fs.mkdirSync(p.retracted, { recursive: true });
      const to = path.join(p.retracted, `${id}.json`);
      try { renameRetry(path.join(p.inbox, `${id}.json`), to); } catch (_) { return false; }
      const m = readJson(to);
      if (m) writeAtomic(to, { ...m, retracted_at: iso(now()), ...(reason ? { retracted_reason: reason } : {}) });
      event('retracted', sid, reason ? { id, reason } : { id });
      return true;
    });
  }

  /** What was taken back from the session, oldest first. */
  function retracted(sid) {
    if (!validSession(sid)) return [];
    const dir = L(sid).retracted;
    return jsonFiles(dir).map((f) => readJson(path.join(dir, f))).filter(Boolean);
  }

  /**
   * Moves what the session never read: to another session's inbox (`to`), or out to <home>/returned/
   * for a router to place. Each move is one rename; the record then gains moved_from or returned_from.
   */
  function handBack(sid, { to = null, reason = null } = {}) {
    const p = L(sid);
    const dest = to ? ensureSession(to).inbox : path.join(home, 'returned');
    fs.mkdirSync(dest, { recursive: true });
    const moved = withLock(p.claimLock, () => {
      const out = [];
      for (const name of jsonFiles(p.inbox)) {
        const target = path.join(dest, name);
        try { renameRetry(path.join(p.inbox, name), target); } catch (_) { continue; }
        const m = readJson(target);
        if (m) {
          if (to) Object.assign(m, { session_id: to, moved_from: sid });
          else Object.assign(m, { returned_from: sid, returned_at: iso(now()) });
          writeAtomic(target, m);
        }
        event('handed_back', sid, { id: m ? m.id : name.slice(0, -5), to, reason });
        out.push(m);
      }
      return out;
    });
    if (to && moved.length) touch(to, 'handed');
    return moved;
  }

  /** What was handed back to nobody in particular, oldest first. */
  const returned = () => jsonFiles(path.join(home, 'returned')).map((f) => readJson(path.join(home, 'returned', f))).filter(Boolean);

  // ── the session's side ─────────────────────────────────────────────────────

  /** The start hook: the session watches its signal from now on. */
  function arm(sid, { source = null, transcript_path = null, cwd = null, entrypoint = null } = {}) {
    const p = ensureSession(sid);
    writeAtomic(p.armed, { at: iso(now()), at_ms: now(), source, transcript_path, cwd, entrypoint });
    event('armed', sid, { source });
    return p.signal;
  }

  /** The end hook: the session stops listening; its pending messages stay or go back (config.onEnd). */
  function disarm(sid, { reason = null } = {}) {
    const p = L(sid);
    for (const f of [p.armed, p.vigia]) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
    const left = pending(sid).map((m) => m.id);
    event('ended', sid, { reason, pending: left });
    if (config.onEnd === 'return' && left.length) handBack(sid, { reason: 'ended' });
    return left;
  }

  /**
   * Whether the session gets a message by itself now, with nobody typing in it: alive, and its watch is
   * armed, its vigia is up, or it is mid-turn.
   */
  function listening(sid) {
    const p = L(sid);
    const info = liveness(sid) || {};
    const armed = readJson(p.armed);
    const known = !!info.known;
    const armedOk = !!armed && (!known || !info.startedAt || (armed.at_ms || 0) >= info.startedAt - 5000);
    const vigia = fs.existsSync(p.vigia);
    const busy = !!info.busy;
    const why = armedOk ? 'watch' : vigia ? 'vigia' : busy ? 'busy' : null;
    const alive = known ? !!info.alive : null;
    return { session_id: sid, listening: alive !== false && !!why, why, alive, busy, armed: armedOk, vigia };
  }

  // ── threads ────────────────────────────────────────────────────────────────

  const threads = (sid) => registry.load(L(sid).dir).threads;
  /** Thread 3 by 3, '3' or 'q3'; or the thread an app knows by its own id, with { ref }. */
  const thread = (sid, which) => {
    const r = registry.load(L(sid).dir);
    return which && typeof which === 'object' ? registry.byRef(r, which.ref) : registry.find(r, markup.threadNumber(which));
  };

  function needThread(r, which) {
    if (which && typeof which === 'object') {
      const t = registry.byRef(r, which.ref);
      if (!t) throw Object.assign(new Error(`no thread with ref ${which.ref}`), { code: 'EBADTHREAD' });
      return t;
    }
    const n = markup.threadNumber(which);
    if (!n) throw Object.assign(new Error(`not a thread: ${which}`), { code: 'EBADTHREAD' });
    return registry.ensure(r, n);
  }

  /**
   * Opens a thread from either side. By the person, `text` is delivered into it; by the session (an ask
   * made through the CLI, say), `text` is recorded as the session's first message in messages.jsonl.
   */
  function openThread(sid, { title = '', text = '', by = 'session', type = null, alert = false, release = null, parent = null, ref = null } = {}) {
    const p = ensureSession(sid);
    const pn = markup.threadNumber(parent);
    const t = registry.update(p.dir, (r) => ({ ...registry.make(r, {
      title: markup.oneLine(title || markup.titleOf(text), 90), title_by: title ? by : null, opened_by: by,
      type, alert: !!alert, release: releaseKeys(release), ref: ref == null || String(ref).trim() === '' ? null : String(ref).trim(),
      parent: pn && registry.find(r, pn) ? markup.threadId(pn) : null, at: iso(now()),
    }) }));
    event('opened', sid, { thread: t.id, by, type, alert: !!alert, release });
    if (String(text).trim()) {
      if (by === 'person') deliverSync(sid, text, { thread: t.n });
      else log(sid, { thread: t.id, from: by, text });
    }
    return t;
  }

  /** A message shown in the thread but never delivered (the session's ask, an app's note). */
  function log(sid, { thread: ref = null, from = 'app', text, at = null }) {
    const p = ensureSession(sid);
    const n = markup.threadNumber(ref);
    const entry = { id: newId(now()), thread: n ? markup.threadId(n) : null, from, text: String(text || '').trim(), at: at || iso(now()) };
    appendJsonl(p.log, entry);
    return entry;
  }
  const logged = (sid) => readJsonl(L(sid).log);

  function rename(sid, ref, title, { by = 'person' } = {}) {
    const t = markup.oneLine(title, 90);
    if (!t) throw Object.assign(new Error('empty title'), { code: 'EEMPTY' });
    const out = registry.update(ensureSession(sid).dir, (r) => ({ ...Object.assign(needThread(r, ref), { title: t, title_by: by, title_at: iso(now()) }) }));
    event('renamed', sid, { thread: out.id, by });
    return out;
  }

  function resolve(sid, ref, { by = 'person' } = {}) {
    const out = registry.update(ensureSession(sid).dir, (r) => ({ ...Object.assign(needThread(r, ref), { status: 'resolved', resolved_at: iso(now()), resolved_by: by }) }));
    event('resolved', sid, { thread: out.id, by });
    return out;
  }

  function reopen(sid, ref) {
    const out = registry.update(ensureSession(sid).dir, (r) => ({ ...Object.assign(needThread(r, ref), { status: 'open', resolved_at: null, resolved_by: null }) }));
    event('reopened', sid, { thread: out.id });
    return out;
  }

  /** Changes a thread's type, red flag, release keys or the app's own id for it (ref). */
  function setThread(sid, which, patch = {}) {
    const allowed = {};
    for (const k of ['type', 'alert', 'release', 'ref']) {
      if (!(k in patch)) continue;
      allowed[k] = k === 'alert' ? !!patch[k] : k === 'release' ? releaseKeys(patch[k]) : (patch[k] == null || patch[k] === '' ? null : patch[k]);
    }
    return registry.update(ensureSession(sid).dir, (r) => ({ ...Object.assign(needThread(r, which), allowed) }));
  }

  /** Threads an app already numbered elsewhere, taken as they are (a one-time import when moving over). */
  function importThreads(sid, list) {
    return registry.update(ensureSession(sid).dir, (r) => list.map((x) => {
      const n = markup.threadNumber(x.n ?? x.id);
      if (!n) return null;
      const t = registry.ensure(r, n);
      for (const k of ['title', 'title_by', 'title_at', 'type', 'alert', 'release', 'opened_by', 'key', 'ref', 'parent', 'at', 'status', 'resolved_at', 'resolved_by']) {
        if (x[k] !== undefined) t[k] = x[k];
      }
      return { ...t };
    }).filter(Boolean));
  }

  /** The person's answers to threads that carry a release key, for a policy hook (docs/PROTOCOL.md). */
  function answers(sid, { release = null, since = null } = {}) {
    return readJsonl(L(sid).answers).filter((a) => (!release || releases(a.release, release)) && (!since || String(a.at) >= String(since)));
  }
  function latestAnswer(sid, release, { withinMs = 60 * 60 * 1000 } = {}) {
    const list = answers(sid, { release, since: iso(now() - withinMs) });
    return list[list.length - 1] || null;
  }

  // ── reading ────────────────────────────────────────────────────────────────

  function sessions() {
    let names = [];
    try { names = fs.readdirSync(path.join(home, 'sessions')).filter(validSession); } catch (_) { return []; }
    return names.map((sid) => ({ session_id: sid, ...session(sid), pending: pending(sid).length, ...listening(sid) }));
  }

  function events({ session: sid = null, since = null } = {}) {
    return readJsonl(eventsFile).filter((e) => (!sid || e.session_id === sid) && (!since || String(e.at) >= String(since)));
  }

  /** Calls `cb(event)` for every event appended from now on, from any process. Returns stop(). */
  function followEvents(cb, { intervalMs = 500 } = {}) {
    let offset = 0;
    try { offset = fs.statSync(eventsFile).size; } catch (_) { /* none yet */ }
    const timer = setInterval(() => {
      let size;
      try { size = fs.statSync(eventsFile).size; } catch (_) { return; }
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = fs.openSync(eventsFile, 'r');
      let buf;
      try { buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      const cut = buf.lastIndexOf(0x0a);
      if (cut < 0) return;
      offset += cut + 1;
      for (const line of buf.toString('utf8', 0, cut).split('\n')) {
        if (!line) continue;
        try { cb(JSON.parse(line)); } catch (_) { /* a torn line or the callback's own error */ }
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  /** The transcript of a Claude Code session: where its start hook said, else found under <claudeDir>/projects. */
  function transcriptOf(sid) {
    const armed = readJson(L(sid).armed);
    if (armed && armed.transcript_path && fs.existsSync(armed.transcript_path)) return armed.transcript_path;
    const s = session(sid);
    if (s.transcript && fs.existsSync(s.transcript)) return s.transcript;
    return require('./claude-code/transcript').find(claude, sid);
  }

  /** The session's threads the way chat-thread's createThreads takes them (src/view.js). */
  function view(sid, opts = {}) {
    return require('./view').build(api, sid, opts);
  }

  /**
   * What the session answered in one thread (3, 'q3' or { ref }), oldest first: [{ id, text, at }], from
   * its transcript split by the marks it wrote, plus the asks it opened through the API. `since` (ISO)
   * keeps the later ones. Empty when the thread is unknown.
   */
  function replies(sid, which, { since = null, transcript: file } = {}) {
    const t = thread(sid, which);
    if (!t) return [];
    const v = view(sid, file === undefined ? {} : { transcript: file });
    const th = v.threads.find((x) => x.n === t.n);
    return (th ? th.messages : [])
      .filter((m) => m.from === 'other' && !m.kind && (!since || String(m.at || '') > String(since)))
      .map((m) => ({ id: m.id, text: m.text, at: m.at || null }));
  }

  const api = {
    home, config, claudeDir: claude, layout: L, now,
    register, session, known, ensureSession, touch,
    deliver, deliverSync, notice,
    pending, claim, formatDelivery, reminder, instructionText, delivered, retract, retracted, handBack, returned,
    arm, disarm, listening, liveness, retouch: (sid) => spawnToucher(sid), tick,
    threads, thread, openThread, log, logged, rename, resolve, reopen, setThread, importThreads,
    answers, latestAnswer,
    sessions, events, followEvents, transcriptOf, view, replies, event,
  };
  return api;
}

module.exports = { open, layout, releaseKeys };
