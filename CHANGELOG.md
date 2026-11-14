# Changelog

## 0.2.0

For an app that routes messages to many sessions and keeps conversations of its own. Everything is optional
and the file protocol stays version 1: 0.1 files read the same, and a 0.1 reader ignores the new fields.

- `onDelivered` (config): a command run detached after every claimed batch, by whichever hook claimed it,
  with the delivered records as JSON on stdin. An app ticks a message delivered the moment it is, without
  following `events.jsonl`.
- `tick` (config): a command run while a session sits idle (by its vigia, at most once per `everyMs`) and on
  every touch of its signal (by the wake). A co-installed tool keeps its periodic check without an idle
  process or a watch of its own, so ai-threads stays the one owner of watches in the session.
- The texts around a delivery: `install --rewake-message` / `--rewake-summary` (kept when installing again
  without them), and `piggybackHeader` in the config (`""` for none).
- Footers: a message may carry a `footer`; a batch prints each distinct footer once, after its messages.
- Retracting is documented as a protocol procedure; the record gains `retracted_at` (and
  `retracted_reason`), the event a `reason`, and `retracted(session)` lists what was taken back.
- `ref`: an app's own id for a thread. A message sent with a `ref` and no thread goes to the thread that
  has it, or opens one that keeps it; `thread(session, { ref })`, `rename`/`resolve`/`reopen`/`setThread`
  with `{ ref }`, and `ref` on each thread of `view`.
- `replies(session, n or { ref }, { since })`: what the session answered in one thread, from its transcript.
- `release` may be a list of keys (one ask that allows more than one thing); an answer counts for each.
- CLI: `send --ref --footer`, `--release a,b`, `open --ref`, `retract --reason`, `replies`.
- The tests run a second implementation of the protocol in Python's standard library
  (`test/fixtures/protocol.py`) against the library: send, claim and retract, both ways. Skipped where no
  Python 3.8+ is on the PATH.

## 0.1.1

- Message ids keep the order they were written in when two land in the same millisecond (one writer never
  repeats the time part); before, the random part could put them out of order on a fast machine.
- Test transcripts take their times from the run, so the suite passes at any hour.

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
