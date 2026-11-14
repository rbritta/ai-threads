# Roadmap

## Next

- **Prompts typed while the session is busy.** Claude Code logs them as `queued_command` attachments;
  the transcript reader skips them today, so they show in the IDE thread only once they become a turn.
- **A transcript that is rewritten instead of appended.** The reader assumes append-only (it reads from
  the last offset); detect a rewrite by a fingerprint of the first line and read again from the start.
- **Rotation of `events.jsonl`.** It only grows; a `prune --before <date>` command, also for old
  `delivered/` records.
- **Grouping above threads.** A level that holds several threads (a review with one thread per item),
  for apps that need it; chat-thread would draw it.

## Later

- Adapters for other hosts with a wake-on-file mechanism, keeping the core and the protocol as they are.
- A tiny HTTP server (`ai-threads serve`) speaking chat-thread's REST store protocol plus live updates,
  for apps that would rather not write their own.
- A two-way transform: the session's replies shown translated, the original kept.
