# Moving an app that keeps its own per-session inbox

For an app that already talks to Claude Code sessions in threads with its own hook: a file per session
that the hook watches, a queue of what the person wrote, a loop that writes the queue into the watched
file, and its own reading of the transcript. ai-threads replaces those parts; the app keeps its screens,
its sign-in, how it opens and closes sessions, and whatever else it reads from the transcript (cost,
files touched, commits).

## What changes

| Before (in the app) | With ai-threads |
|---|---|
| A watched file per session that holds the message itself, rewritten by a delivery loop | Messages in `inbox/`, claimed by rename; the watched file is only a signal. No loop: `deliverSync()` queues and touches. |
| A list of delivered ids appended by the hook, matched against the app's queue | `delivered/` records and `events.jsonl`; `pending(session)` is the queue. |
| An "armed" file written at session start | `state/armed.json`; `listening(session)` says whether the session gets messages by itself now. |
| The hook only on FileChanged | Also a Stop vigia, the prompt piggyback and re-touches after start: delivery survives a watcher that went down and a session that starts with messages waiting. |
| A FileChanged hook that returns `watchPaths` to re-arm the watch | Removed: it can replace other tools' watches. Nothing removes the watched file, so it never needs re-arming. |
| The thread list inside the app's session record | `threads.json`, one per session, under a lock. |
| Reading the transcript for the threads | `view(session)`, already in chat-thread's shape. |
| The instruction sent with the first prompt | Sent by ai-threads with the first threaded delivery, once, and recalled after a resume, clear or compaction. |

## Steps

1. **Install the hooks next to the app's own.** `ai-threads install` (or `--settings` for a project file).
   Set `entrypoints` in `<home>/config.json` if the app only serves one kind of session
   (`["claude-vscode"]`), `app` for the instruction, and `instructions` / `newWords` when the app tells
   its sessions in its own words.
2. **Import the threads once**, per session, from the app's record:

   ```js
   at.importThreads(sid, record.threads.map((q) => ({
     n: q.n, title: q.title, at: q.createdAt,
     title_by: q.titleBy || null, title_at: q.titledAt || null,
     opened_by: q.origin,                         // 'person', 'session' or 'ide'
     key: q.key ? q.key.replace(/^c:/, 'new:') : null, // see below
     parent: q.parent ? `q${q.parent}` : null,
     status: q.resolvedAt ? 'resolved' : 'open', resolved_at: q.resolvedAt || null,
   })));
   at.register(sid, { instructed: true, app: 'the app' }); // it was told already
   ```

   Threads the session opened are keyed by the transcript entry that opened them and their count in
   that entry: `new:<entry uuid>:<i>`. An app that keyed them the same way with another prefix only
   renames the prefix, and the numbers stay.
3. **Move what was still queued** with `deliverSync(sid, text, { thread: n })`, then drop the app's queue.
4. **Replace the calls:**

   | The app did | Now |
   |---|---|
   | push to its queue | `deliverSync(sid, text, { thread: n })`; a new thread: no `thread`, `parent` for a derived one |
   | the delivery loop | nothing |
   | mark a thread resolved / reopened | `resolve(sid, n)` / `reopen(sid, n)` |
   | rename a thread | `rename(sid, n, title, { by: 'person' })` |
   | drop the queue when the session is closed for good | `pending(sid).forEach((m) => retract(sid, m.id))` |
   | "is it armed?" | `listening(sid).listening` |
   | build the threads from the transcript | `view(sid, { persist: true, labels, origins })` from one place |

5. **Remove the old hook** from the settings, keep the app's data until a few sessions went through.

## Differences you will notice

- A message written while the session is closed waits in the inbox and arrives when it opens again, at
  start, by the re-touch; the app no longer has to keep it.
- A mark the session writes (`[Q3]`) holds until the next mark for the whole turn, not only the block it
  was written in.
- Message ids are stable (the message's own id, or the transcript entry's), so a page can update a
  thread in place instead of redrawing it.
- The person's message is ordered by when it reached the session: one written while the session was
  answering sits after that answer.
