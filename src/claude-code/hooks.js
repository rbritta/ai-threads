'use strict';
/*
 * The Claude Code hooks that deliver a session's messages in every state it can be in.
 *
 *   start   SessionStart (every source): arms the watch on the session's signal file (watchPaths) and,
 *           when messages are already waiting, has a detached process re-touch the signal at 4, 12 and
 *           30 s, because the watcher only comes up after the start hooks return. After a resume, a
 *           clear or a compaction it also reminds the session of the Q markup, if it was told before.
 *   wake    FileChanged with asyncRewake: the signal was touched. Claims the batch and exits 2 with it on
 *           stderr, which wakes the session idle, busy, or before its first turn.
 *   vigia   Stop with asyncRewake: while the session sits idle, looks every 2 s and wakes it the same way.
 *           The fallback for a watcher that went down. The next Stop starts a new vigia and this one leaves;
 *           so it does when the session is gone.
 *   prompt  UserPromptSubmit: what was waiting rides along with what the person typed, as context.
 *   end     SessionEnd: the session stops listening; its undelivered messages stay (or go back, onEnd).
 *
 * Never in a subagent (the input has agent_id). A hook never returns watchPaths outside SessionStart and
 * never removes or renames a watched file: Claude Code keeps one watcher per session, shared by every tool.
 */
const fs = require('fs');
const util = require('../util');

const PIGGYBACK_HEADER = 'Messages for this session that were waiting (ai-threads):';

function makeHooks(api, { env = process.env, sleep = util.sleep } = {}) {
  const cfg = api.config;

  /** True when this hook has nothing to do here: no session, a subagent, or an entrypoint not chosen. */
  function skip(input) {
    if (!input || !util.validSession(input.session_id) || input.agent_id) return true;
    const eps = cfg.entrypoints;
    return Array.isArray(eps) && eps.length > 0 && !eps.includes(env.CLAUDE_CODE_ENTRYPOINT);
  }

  function start(input) {
    if (skip(input)) return null;
    const sid = input.session_id;
    const signal = api.arm(sid, {
      source: input.source || null, transcript_path: input.transcript_path || null, cwd: input.cwd || null,
      entrypoint: env.CLAUDE_CODE_ENTRYPOINT || null,
    });
    const out = { hookEventName: 'SessionStart', watchPaths: [signal] };
    const remind = input.source && input.source !== 'startup' ? api.reminder(sid) : null;
    if (remind) out.additionalContext = remind;
    if (api.pending(sid).length) api.retouch(sid);
    return { stdout: JSON.stringify({ hookSpecificOutput: out }) };
  }

  function wake(input) {
    if (skip(input)) return null;
    const sid = input.session_id;
    if (!util.samePath(input.file_path, api.layout(sid).signal)) return null; // another tool's file
    const msgs = api.claim(sid, { via: 'wake' });
    if (!msgs.length) return null;
    return { stderr: api.formatDelivery(sid, msgs), code: 2 };
  }

  async function vigia(input) {
    if (skip(input)) return null;
    const sid = input.session_id;
    // A process that stays while the session sits idle is only worth it in a session ai-threads is used in
    // (registered, or sent a message once). Any other session still has its watch from the start hook.
    if (!api.known(sid)) return null;
    const p = api.layout(sid);
    fs.mkdirSync(p.state, { recursive: true });
    const token = `${process.pid} ${Date.now()} ${Math.random()}`;
    fs.writeFileSync(p.vigia, token);
    const mine = () => { try { return fs.readFileSync(p.vigia, 'utf8') === token; } catch (_) { return false; } };
    const leave = () => { if (mine()) { try { fs.unlinkSync(p.vigia); } catch (_) { /* gone */ } } };
    const { stepMs, maxMs, aliveCheckMs } = cfg.vigia;
    const until = Date.now() + maxMs;
    let checked = Date.now();
    try {
      while (Date.now() < until) {
        await sleep(stepMs);
        if (!mine()) return null; // a newer vigia took over, or the session ended
        const msgs = api.claim(sid, { via: 'vigia' });
        if (msgs.length) return { stderr: api.formatDelivery(sid, msgs), code: 2 };
        if (Date.now() - checked >= aliveCheckMs) {
          checked = Date.now();
          const info = api.liveness(sid) || {};
          if (!info.alive) return null;
        }
      }
      return null;
    } finally {
      leave(); // the mark says the session listens: it goes with the vigia, whatever ended it
    }
  }

  function prompt(input) {
    if (skip(input)) return null;
    const sid = input.session_id;
    const msgs = api.claim(sid, { via: 'prompt' });
    if (!msgs.length) return null;
    const ctx = `${PIGGYBACK_HEADER}\n\n${api.formatDelivery(sid, msgs)}`;
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }) };
  }

  function end(input) {
    if (skip(input)) return null;
    api.disarm(input.session_id, { reason: input.reason || null });
    return null;
  }

  /** The detached re-toucher: rewrites the signal in place until nothing is waiting, at most len(touches) times. */
  async function touch(sid) {
    if (!util.validSession(sid)) return;
    for (const s of cfg.touches) {
      await sleep(s * 1000);
      if (!api.pending(sid).length) return;
      api.touch(sid, 'retouch');
    }
  }

  return { start, wake, vigia, prompt, end, touch, skip };
}

const EVENTS = ['start', 'wake', 'vigia', 'prompt', 'end'];

module.exports = { makeHooks, EVENTS, PIGGYBACK_HEADER };
