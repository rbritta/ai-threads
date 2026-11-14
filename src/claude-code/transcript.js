'use strict';
/*
 * Reads a Claude Code transcript (<claude dir>/projects/<project>/<session id>.jsonl) into thread
 * messages, a little at a time: each call reads only what the file grew since the last one.
 *
 *   a person's turn with marks       a delivered batch: one message per mark ([Q3 · title] text)
 *   a person's turn without marks    text typed straight into the session: thread key `ide`
 *   the session's text               split by the marks it wrote (markup.parseReply)
 *
 * Skipped: subagents (isSidechain), meta entries, tool results, task notifications with no marks,
 * slash commands, synthetic replies. Tool calls become the activity of the reply that follows them,
 * by their description only, never the command (it may carry a secret). Nothing here calls a model.
 */
const fs = require('fs');
const path = require('path');
const markup = require('../markup');

const IDE_TAGS = /<((?:ide_|system-reminder|command-|local-command-|task-notification)[a-z_-]*)[^>]*>[\s\S]*?<\/\1>/gi;
const MAX_ACTIVITY = 200;

/** A new reading state. `messages` grows as the transcript does. */
function newState() {
  return {
    offset: 0,
    current: null, // the thread of the last message delivered or typed
    reply: null, // the thread the session's text is in now (marks move it until the next turn)
    messages: [],
    renames: new Map(),
    activity: [],
    title: null,
    firstAt: null,
    lastAt: null,
  };
}

function describe(block) {
  const inp = block.input || {};
  if (block.name === 'Skill') return String(inp.skill || '');
  const target = inp.file_path || inp.notebook_path;
  return markup.oneLine(inp.description || (target ? path.basename(String(target)) : '') || inp.pattern || '', 120);
}

function batch(st, j, items, via) {
  items.forEach((it, k) => {
    const key = markup.threadId(it.n);
    st.messages.push({ id: k ? `${j.uuid}:${k}` : j.uuid, key, from: 'person', at: j.timestamp, text: it.text, title: it.title, via });
  });
  st.current = markup.threadId(items[items.length - 1].n);
  st.reply = st.current;
  st.activity = [];
}

function onUser(st, j) {
  const ct = j.message && j.message.content;
  if (Array.isArray(ct) && ct.some((x) => x && x.type === 'tool_result')) return;
  if (j.isMeta) return;
  const raw = typeof ct === 'string' ? ct : Array.isArray(ct) ? ct.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
  if (!raw) return;
  const items = markup.parseDelivered(raw);
  if (items.length) return batch(st, j, items, raw.includes('<task-notification>') ? 'rewake' : 'turn');
  if (raw.includes('<task-notification>')) return;
  const text = raw.replace(IDE_TAGS, '').replace(/<\/?pasted_content[^>]*>/gi, '').trim();
  if (!text || /^<(command|local-command)/.test(text)) return;
  st.messages.push({ id: j.uuid, key: 'ide', from: 'person', at: j.timestamp, text, via: 'ide' });
  st.current = 'ide';
  st.reply = 'ide';
  st.activity = [];
}

/** What the prompt hook added as context (piggybacked messages) is a delivered batch too. */
function onAttachment(st, j) {
  const a = j.attachment || {};
  if (a.type !== 'hook_additional_context' || a.hookEvent === 'SessionStart') return;
  for (const c of [].concat(a.content || [])) {
    const items = markup.parseDelivered(String(c || ''));
    if (items.length) batch(st, { ...j, uuid: j.uuid || `${j.timestamp}` }, items, 'prompt');
  }
}

function onAssistant(st, j) {
  const msg = j.message || {};
  if (msg.model === '<synthetic>') return;
  let k = 0; // parts of this entry
  let opened = 0; // threads this entry opened: their key is new:<entry uuid>:<count>
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (!b) continue;
    if (b.type === 'tool_use') {
      st.activity.push({ name: b.name, text: describe(b) });
      if (st.activity.length > MAX_ACTIVITY) st.activity.shift();
      continue;
    }
    if (b.type !== 'text' || !String(b.text || '').trim()) continue;
    const r = markup.parseReply(b.text, st.reply || st.current || 'q1');
    for (const rn of r.renames) st.renames.set(rn.n, { title: rn.title, at: j.timestamp });
    for (const part of r.parts) {
      const id = `${j.uuid}:${k++}`;
      if (part.opens) {
        st.messages.push({ id, key: `new:${j.uuid}:${opened++}`, from: 'session', at: j.timestamp, text: part.text, opens: part.opens, parent: part.parent, actions: [] });
        continue;
      }
      st.messages.push({ id, key: part.key, from: 'session', at: j.timestamp, text: part.text, actions: st.activity });
      st.activity = [];
    }
    st.reply = r.current;
  }
}

function onEntry(st, j) {
  if (!j || j.isSidechain) return;
  if (j.timestamp) { st.lastAt = j.timestamp; st.firstAt = st.firstAt || j.timestamp; }
  if (j.type === 'user') onUser(st, j);
  else if (j.type === 'assistant') onAssistant(st, j);
  else if (j.type === 'attachment') onAttachment(st, j);
  else if (j.type === 'custom-title' && j.customTitle) st.title = j.customTitle;
  else if (j.type === 'ai-title' && j.aiTitle && !st.title) st.title = j.aiTitle;
}

const CACHE = new Map();

/**
 * Reads what `file` grew since the last call and returns the state. `opts.state` keeps your own state
 * instead of the module's cache; `opts.onEntry(entry)` sees every parsed line too, for an app that
 * wants more from the same pass (cost, files touched).
 */
function read(file, opts = {}) {
  let st = opts.state || CACHE.get(file);
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return st || newState(); }
  if (!st || size < st.offset) { st = newState(); if (!opts.state) CACHE.set(file, st); }
  if (size > st.offset) {
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(size - st.offset);
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, st.offset));
    } finally { fs.closeSync(fd); }
    const cut = buf.lastIndexOf(0x0a);
    if (cut >= 0) {
      st.offset += cut + 1;
      for (const line of buf.toString('utf8', 0, cut).split('\n')) {
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch (_) { continue; }
        if (opts.onEntry) { try { opts.onEntry(j); } catch (_) { /* the app's own */ } }
        onEntry(st, j);
      }
    }
  }
  return st;
}

/** The transcript file of a session under <claude dir>/projects, or null. */
function find(claudeDir, sid) {
  const proj = path.join(claudeDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(proj); } catch (_) { return null; }
  for (const d of dirs) {
    const f = path.join(proj, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

module.exports = { newState, read, find, onEntry, CACHE };
