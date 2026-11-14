'use strict';
/*
 * One session's threads, put together the way chat-thread's createThreads takes them, so an app hands
 * them over as they come: `createThreads(el, { mode: 'questions', threads: view.threads })`.
 *
 * Where each message comes from:
 *   the person's messages      delivered/ (exact text, the time written; ordered by when delivered),
 *                              inbox/ (still queued), and the transcript for what reached the session
 *                              some other way (typed in the IDE, an older delivery)
 *   the session's messages     the transcript, split by the marks it wrote; messages.jsonl for asks
 *                              opened through the API
 *
 * Threads the session opened (`[Q new · title]`) and the one for text typed in the IDE get a number the
 * first time they are seen. With `persist`, that number is written to the registry; without it, the
 * number is worked out the same way but not kept.
 */
const registry = require('./registry');
const markup = require('./markup');
const transcript = require('./claude-code/transcript');

const LABELS = Object.freeze({
  queued: 'Queued', sent: 'Sent', stopped: 'Session closed', empty: '', waiting: '', working: '', resolved: '', thinking: 'Thinking',
});
const ORIGINS = Object.freeze({ session: 'opened by the session', ide: 'typed in the IDE', app: 'opened by an app', person: '' });
const TONE = { waiting: 'wait', working: 'busy' };

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const ms = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : 0; };

function build(api, sid, opts = {}) {
  const labels = { ...LABELS, ...(opts.labels || {}) };
  const origins = { ...ORIGINS, ...(opts.origins || {}) };
  const dir = api.layout(sid).dir;
  const file = opts.transcript === null ? null : (opts.transcript || api.transcriptOf(sid));
  const words = { newWords: api.config.newWords };
  const st = file ? transcript.read(file, words) : transcript.newState(words);
  const live = api.listening(sid);
  const sess = api.session(sid);

  // the threads that need a number: the IDE one and the ones the session opened
  const keyed = [];
  const seen = new Set();
  for (const m of st.messages) {
    if ((m.key === 'ide' || m.key.startsWith('new:')) && !seen.has(m.key)) {
      seen.add(m.key);
      keyed.push(m);
    }
  }
  const numbers = (r) => {
    const toN = (key) => {
      if (!key) return null;
      const n = markup.threadNumber(key);
      if (n) return n;
      const t = registry.byKey(r, key);
      return t ? t.n : null;
    };
    for (const m of keyed) {
      if (registry.byKey(r, m.key)) continue;
      if (m.key === 'ide') registry.make(r, { key: 'ide', opened_by: 'ide', title: '', at: m.at });
      else {
        const pn = toN(m.parent);
        registry.make(r, { key: m.key, opened_by: 'session', title: m.opens || '', title_by: 'session', title_at: m.at, parent: pn ? markup.threadId(pn) : null, at: m.at });
      }
    }
    for (const m of st.messages) {
      const n = markup.threadNumber(m.key);
      if (n) registry.ensure(r, n, { at: m.at });
    }
    return JSON.parse(JSON.stringify(r));
  };
  const reg = opts.persist ? registry.update(dir, numbers) : numbers(registry.load(dir));
  const nOf = (key) => {
    if (!key) return null;
    const n = markup.threadNumber(key);
    if (n) return n;
    const t = registry.byKey(reg, key);
    return t ? t.n : null;
  };

  const byN = new Map(reg.threads.map((t) => [t.n, []]));
  const put = (n, msg) => { if (!n) return; if (!byN.has(n)) byN.set(n, []); byN.get(n).push(msg); };

  // the person's messages that ai-threads delivered: exact, and they stand for the same text in the transcript
  const pool = new Map();
  for (const m of api.delivered(sid)) {
    const n = m.kind !== 'notice' ? markup.threadNumber(m.thread) : null;
    if (!n) continue;
    const k = `${n}|${norm(m.text)}`;
    pool.set(k, (pool.get(k) || 0) + 1);
    put(n, { id: m.id, from: 'me', text: m.text, at: m.at, sort: ms(m.delivered_at || m.at), tag: m.from && m.from !== 'person' ? m.from : undefined });
  }
  for (const m of st.messages) {
    const n = nOf(m.key);
    if (m.from === 'person') {
      const k = `${n}|${norm(m.text)}`;
      if (pool.get(k)) { pool.set(k, pool.get(k) - 1); continue; }
      put(n, { id: m.id, from: 'me', text: m.text, at: m.at, sort: ms(m.at) });
      continue;
    }
    put(n, { id: m.id, from: 'other', text: m.text, at: m.at, sort: ms(m.at), actions: m.actions && m.actions.length ? m.actions : undefined });
  }
  for (const e of api.logged(sid)) {
    const n = markup.threadNumber(e.thread);
    if (!n) continue;
    put(n, e.from === 'person'
      ? { id: e.id, from: 'me', text: e.text, at: e.at, sort: ms(e.at) }
      : { id: e.id, from: 'other', text: e.text, at: e.at, sort: ms(e.at), kind: e.from === 'session' ? undefined : 'note' });
  }
  const pend = api.pending(sid);
  for (const m of pend) {
    const n = m.kind !== 'notice' ? markup.threadNumber(m.thread) : null;
    if (!n) continue;
    put(n, { id: m.id, from: 'me', text: m.text, at: m.at, sort: 1e15 + ms(m.at), state: 'queued', tag: labels.queued || undefined, queued: true });
  }

  const currentN = nOf(st.current);
  const out = [];
  for (const t of reg.threads) {
    const msgs = (byN.get(t.n) || []).sort((a, b) => a.sort - b.sort);
    let lastOther = -1;
    msgs.forEach((m, i) => { if (m.from === 'other') lastOther = i; });
    const messages = msgs.map((m, i) => {
      const { sort, queued, ...rest } = m;
      if (m.from === 'me' && !queued) rest.state = i < lastOther ? 'read' : 'delivered';
      for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
      return rest;
    });
    const last = msgs[msgs.length - 1];
    let state;
    if (t.status === 'resolved') state = 'resolved';
    else if (last && last.queued) state = 'queued';
    else if (live.busy && t.n === currentN) state = 'working';
    else if (last && last.from === 'other') state = 'waiting';
    else if (last && last.from === 'me') state = live.alive === false ? 'stopped' : 'sent';
    else state = 'empty';

    let title = t.title || '';
    let titleBy = t.title_by || null;
    const rn = st.renames.get(t.n);
    if (rn && !(t.title_by === 'person' && ms(t.title_at) > ms(rn.at))) { title = rn.title; titleBy = 'session'; }
    const parentN = markup.threadNumber(t.parent);
    const parent = parentN ? reg.threads.find((x) => x.n === parentN) : null;
    const act = st.activity[st.activity.length - 1];
    out.push({
      id: t.id, n: t.n, title, titleBy, titleByAI: titleBy === 'session',
      at: t.at || (messages[0] || {}).at || null,
      status: t.status === 'resolved' ? 'resolved' : 'open',
      resolvedAt: t.resolved_at || null, resolvedBy: t.resolved_by || null,
      state, tone: TONE[state] || 'idle', label: labels[state] || '',
      activity: state === 'working' ? (act ? `${act.name}${act.text ? ` · ${act.text}` : ''}` : labels.thinking) : '',
      origin: origins[t.opened_by] || '',
      openedBy: t.opened_by, type: t.type || null, alert: !!t.alert, release: t.release || null, ref: t.ref == null ? null : t.ref,
      parent: parent ? { id: parent.id, n: parent.n, title: parent.title || '' } : null,
      messages,
    });
  }

  let state;
  if (live.busy) state = 'working';
  else if (out.some((t) => t.state === 'waiting')) state = 'waiting';
  else if (out.some((t) => t.state === 'queued')) state = 'queued';
  else if (live.alive) state = 'open';
  else state = live.alive === false ? 'stopped' : 'unknown';

  return {
    session: {
      id: sid, title: st.title || sess.title || null, state,
      alive: live.alive, busy: live.busy, listening: live.listening, why: live.why,
      pending: pend.length, firstAt: st.firstAt, lastAt: st.lastAt, transcript: file || null,
    },
    threads: out,
  };
}

module.exports = { build, LABELS, ORIGINS };
