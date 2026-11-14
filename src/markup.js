'use strict';
/*
 * The Q markup: how one conversation with an AI session is split into threads, in plain text that the
 * session reads and writes. Nothing here calls a model or touches a file.
 *
 *   [Q3 · Deploy fails]   heads every message delivered into the session: what follows is thread 3
 *   [Q3]                  a line alone in a reply: the text below it goes to thread 3, until the next mark
 *   [Q new · title]       a line alone in a reply: the session opens a new thread, the text below is its first
 *                         message (an app that tells its sessions in another language adds its own word for
 *                         `new` with the config's `newWords`)
 *   [Q3 → better title]   a line alone in a reply: the session renames thread 3 (`->` works too)
 *
 * A reply with no mark goes to the thread of the last message delivered before it.
 */

const SEP = '·';
const NEW_WORDS = Object.freeze(['new']);
const MAX_TITLE = 90;

/** Thread 3 as its id. */
const threadId = (n) => `q${n}`;

/** The number of a thread from 3, '3', 'q3' or 'Q3'; null when it is none of those. */
function threadNumber(ref) {
  if (ref == null || ref === '') return null;
  const m = /^[qQ]?(\d{1,6})$/.exec(String(ref).trim());
  return m && +m[1] > 0 ? +m[1] : null;
}

function oneLine(text, max = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A title from a text: its first non-empty line, short. Empty when there is none. */
function titleOf(text, max = 70) {
  return oneLine(String(text || '').split('\n').find((l) => l.trim()) || '', max);
}

/** The mark that heads a delivered message. Brackets in the title would end the mark early, so they go. */
function mark(n, title) {
  const t = oneLine(String(title || '').replace(/[[\]]/g, ''), 60);
  return t ? `[Q${n} ${SEP} ${t}]` : `[Q${n}]`;
}

/**
 * The text the session reads for a batch: each thread message headed by its mark, notices as they are,
 * a blank line between them. Items: { n, title, text } or { text } for a message with no thread.
 */
function formatBatch(items) {
  return items.map((it) => (it.n ? `${mark(it.n, it.title)} ${String(it.text).trim()}` : String(it.text).trim())).join('\n\n');
}

const RE_DELIVERED = new RegExp(`\\[Q(\\d{1,6})(?: ${SEP} ([^\\]\\n]{0,${MAX_TITLE}}))?\\]\\s*`, 'g');
const RE_LEAD_Q = new RegExp(`^\\s*\\[Q(\\d{1,6})(?:\\s${SEP}\\s[^\\]\\n]{0,${MAX_TITLE}})?\\][ \\t]*(?:\\n|$)`);
const RE_RENAME = new RegExp(`^[ \\t]*\\[Q(\\d{1,6})\\s(?:→|->)\\s([^\\]\\n]{1,${MAX_TITLE}})\\][ \\t]*$`, 'gm');

/** `new` plus the extra words given (one word each, no spaces or brackets), the ones that open a thread. */
function newWords(extra) {
  const more = (Array.isArray(extra) ? extra : []).filter((w) => typeof w === 'string' && /^[^\s[\]·→]{1,20}$/.test(w));
  return [...new Set([...NEW_WORDS, ...more])];
}

const OPENERS = new Map();
/** The two patterns that hold the words for `new`: a mark line, and the mark that opens a thread. */
function openers(extra) {
  const words = newWords(extra);
  const key = words.join('\n');
  if (!OPENERS.has(key)) {
    const alt = words.map((w) => w.replace(/[.*+?^${}()|\\-]/g, '\\$&')).join('|');
    OPENERS.set(key, {
      line: new RegExp(`^\\s*\\[Q(?:\\d{1,6}|\\s(?:${alt}))(?:\\s${SEP}[^\\]\\n]{0,${MAX_TITLE}})?\\]\\s*$`),
      open: new RegExp(`^\\s*\\[Q\\s(?:${alt})\\s${SEP}\\s([^\\]\\n]{1,${MAX_TITLE}})\\][ \\t]*(?:\\n|$)`),
    });
  }
  return OPENERS.get(key);
}

/**
 * A delivered batch split back into its thread messages: [{ n, title, text }], in order. Empty when the
 * text has no mark. What a hook wraps around the batch after it (a closing tag) is cut.
 */
function parseDelivered(text) {
  const raw = String(text || '');
  const marks = [...raw.matchAll(RE_DELIVERED)];
  if (!marks.length) return [];
  const rest = raw.replace(/\s*<\/system-reminder>[\s\S]*$/, '');
  return marks.map((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].index : rest.length;
    return { n: +m[1], title: (m[2] || '').trim(), text: rest.slice(m.index + m[0].length, Math.max(end, m.index + m[0].length)).trim() };
  });
}

/**
 * One text block the session wrote, split by thread. `current` is the thread key the text starts in
 * (`q3`, or any key an app uses for text typed straight into the session, like `ide`).
 *
 * Returns { current, parts, renames }:
 *   parts    [{ key, text }] for text in a thread, [{ opens: title, parent: key, text }] for a new thread
 *   renames  [{ n, title }] from `[Qn → title]` lines, taken out of the text
 *   current  the thread the text ends in, so the next block of the same turn continues there
 *
 * `newWords`: words besides `new` that open a thread (`[Q <word> · title]`).
 */
function parseReply(text, current = null, { newWords: extra = null } = {}) {
  const { line: RE_LINE_MARK, open: RE_NEW } = openers(extra);
  const renames = [];
  const body = String(text || '').replace(RE_RENAME, (_, n, t) => { renames.push({ n: +n, title: titleOf(t) }); return ''; });
  const parts = [];
  let key = current;
  if (!body.trim()) return { current: key, parts, renames };
  const chunks = [];
  for (const line of body.split('\n')) {
    if (RE_LINE_MARK.test(line) || !chunks.length) chunks.push(line);
    else chunks[chunks.length - 1] += `\n${line}`;
  }
  for (let c of chunks) {
    const q = RE_LEAD_Q.exec(c);
    if (q) { key = threadId(+q[1]); c = c.slice(q[0].length); }
    const nw = RE_NEW.exec(c);
    if (nw) {
      parts.push({ opens: titleOf(nw[1]), parent: key, text: c.slice(nw[0].length).trim() });
      continue;
    }
    if (c.trim()) parts.push({ key, text: c.trim() });
  }
  return { current: key, parts, renames };
}

/**
 * What the session is told once, so it answers in threads. `{app}` names who follows the session;
 * a custom text (another wording, another language) can use the same placeholder.
 */
const INSTRUCTION = 'This session is followed in {app}, where the conversation is split into threads, the Qs. Each message I send arrives marked [Qn · title], and what you answer next goes to that Q. When a message brings more than one Q, or you go back to an earlier Q, start each part of your answer with the line [Qn] (alone on its own line): what follows goes to that Q. If a separate question comes up that should not hold up the Q you are in, open another by writing on its own line [Q new · short title], with the question right below it. If the title of a Q does not say what it is about, give it a better one on its own line [Qn → short title].';

/** The instruction, or `custom` when given; `app` fills {app}. */
function instruction({ app = null, custom = null } = {}) {
  return (custom || INSTRUCTION).replace(/\{app\}/g, app || 'an app');
}

module.exports = {
  SEP, NEW_WORDS, threadId, threadNumber, oneLine, titleOf, mark, formatBatch, parseDelivered, parseReply,
  newWords, INSTRUCTION, instruction,
};
