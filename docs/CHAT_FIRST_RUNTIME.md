# Chat-first runtime

CareerRat owns conversation identity and work state. The selected CLI agent is an
execution engine, not the database.

## Durable state

SQLite stores the main conversation, earned job conversations, ordered messages,
mock interviews, missions, mission steps, execution attempts, leases, receipts,
and user gates. Markdown remains the readable artifact format for job
descriptions, research, dossiers, resumes, and optional exports. A Markdown file
is not the canonical representation of a conversation.

Every job-conversation turn follows the same runtime-neutral cycle:

1. Persist the user's message.
2. Assemble a bounded context pack from current canonical state.
3. Call the configured local AI runtime once.
4. Persist the assistant reply or a durable error receipt.

CareerRat owns these workflows and threads. Their state stays provider-neutral,
even when the selected execution engine changes between turns.

## Quality and thinking policy

User settings are provider-neutral rather than raw model names. **Automatic**
resolves quality and thinking depth from the operation: Paul and high-stakes
application judgment stay strong, web research uses the balanced path, and small
bounded classification uses the faster path. **Faster**, **Balanced**, and
**Best** set an overall quality preference; **Thinking depth** can be Automatic,
Low, Medium, or High. The adapter maps that plan to Claude Code or OpenAI Codex
without ranking providers or crossing between them.

Each operation freezes its resolved runtime, quality, model, and reasoning plan
when it starts. A Settings change applies to new work only, and a retry reuses
the original plan rather than changing quality halfway through the task.

The context pack includes candidate constraints and evidence, current application
and communication facts, a rolling thread checkpoint with an exact sequence
boundary, messages after that checkpoint, unresolved mission gates, and bounded
relevant artifact content. Referencing a resume alone is not enough because it
does not explain the current decision, conversation, or due action.

## Returning to a conversation

CareerRat rehydrates a returning agent from its own durable state, so
conversation identity is runtime-neutral. Claude Code and OpenAI Codex are the
supported engines for the complete CareerRat workflow. Each local install must
pass availability, authentication, and the complete readiness check before it
becomes selectable. A failed check stops clearly without switching providers.

Vendor-specific exact-session resume handles may be added later as optional
acceleration metadata. They cannot become the source of truth because retention,
privacy, working-directory identity, and resume behavior differ by runtime. If a
native resume fails, canonical rehydration must still work.

## Background work

Search and intake workers are owned by the single CareerRat runtime for the
workspace, not by a mounted page or open conversation. They continue in the
background when the user navigates to another view, and the UI restores their
durable status after reload. Clean shutdown aborts and awaits active workers. If
the process stops unexpectedly, startup reconciles the orphaned operation and
surfaces a retry; it never rewrites an interrupted run as completed.

## Missions

A mission is a durable run of ordered work steps, not a long-lived CLI process.
Each executable step records an attempt identity, lease and fence, idempotency
classification, provenance, and completion or failure receipt. Active leases
prevent concurrent execution. An expired step whose outcome is uncertain pauses
for review instead of replaying a potentially destructive action.

Mission execution routes domain work through the shared workspace executor. A
mission can prepare packets and fill supported fields, but final application
submission is always represented by a blocked user gate. CareerRat never treats
an agent reply as proof that a submission happened.

## Backup and export

The workspace export path uses SQLite's backup API to capture a consistent
database snapshot, including chat-first tables, and bundles readable exports.
Copying only the live database file is unsafe in WAL mode and is not a supported
backup procedure. Private data directories and database files use owner-only
permissions.

## External references

- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [SQLite backup API](https://www.sqlite.org/backup.html)
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [OpenAI compaction guidance](https://developers.openai.com/api/docs/guides/compaction)
