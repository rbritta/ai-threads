# Changelog

## 0.1.0

First release.

- A per-session inbox with a documented, language-neutral file protocol: messages written atomically,
  claimed exactly once by rename into `delivered/` (with `delivered_at`, `session_id`, `via`), an
  `events.jsonl` of what was queued, delivered, retracted and handed back.
- Threads opened by either side, with a type, a red flag and a release key; resolved from either side,
  reopened when the person writes again; derived threads keep their parent.
- The Q markup (`[Qn · title]`, `[Qn]`, `[Q new · title]` / `[Q nova · title]`, `[Qn → title]`) with
  the instruction in English and Portuguese, sent once and recalled after a resume, clear or compaction.
- Claude Code hooks: start (watch + re-touch), wake (FileChanged `asyncRewake`), vigia (Stop
  `asyncRewake`, only in sessions ai-threads is used in), prompt (piggyback), end. Never in a subagent;
  an optional entrypoint filter. The watched file is only ever overwritten.
- `listening()`: whether a session gets a message by itself now (watch armed, vigia up, or mid-turn).
- Hand back what a session never read, to another session or to `returned/`; retract a message still
  waiting.
- Answers to threads with a release key, for policy hooks.
- `view()`: a session's threads in chat-thread's `createThreads` shape, from the registry, the inbox, the
  delivered records and the transcript.
- An optional transform before queueing (translation, say), keeping the original.
- The `ai-threads` command: send, list, threads, view, open, rename, resolve, reopen, retract, handback,
  answers, register, status, events, install, remove, hook.
