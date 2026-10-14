# cc-rsi architecture

This document explains how cc-rsi is built: the decisions behind it, its process model and trust boundaries, its state machines and invariants, a map of the modules, the remaining differences from RSIAgent, and what the implementers observed on the real Claude Code binary. The normative interfaces are in [design/SPEC.md](design/SPEC.md); where the implementation departs from the specification, the departure is listed in [Recorded deviations from the specification](#recorded-deviations-from-the-specification). The specification has not yet been updated for the fixes of the latest review round (61 findings); that section lists the behaviour it does not yet describe. For installation and use, see the [README](../README.md).

Vocabulary: the **Actor** does the work (the user's main session in interactive mode, a headless child in lineages); the **Verifier** inspects the result and returns a verdict; the **Curriculum** authors practice projects and decides when to retry the target; the **summarizer** writes work logs for resumes. A **role child** is one `claude -p` process sending one role message. **Infra** means an infrastructure outcome (transport, auth, crash, timeout, …), which is never a verdict.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Interactive Verifier | A headless `claude -p` child run by a detached **verification job** that the `submit` MCP tool starts. One Verifier session per task: the first inspection uses `--session-id`, later ones `--resume`, so the same Verifier follows FAIL → repair → re-verify across turns and Claude Code restarts, as long as its transcript still matches the fingerprint recorded after its last job. The job checkpoints the candidate, holds a project-wide workspace lock, restores the candidate (moving displaced files aside, never deleting them) and owns the verdict. `submit` and `wait_verdict` wait at most `interactive.waitSeconds` (≤ 110 s), and the wait ends 10 s plus an 8 s delivery reserve before Claude Code's auto-background threshold, counted from the arrival of `tools/call` (floor 1 s); an async PostToolUse hook tries to wake the session once per job when the verdict lands. No plugin subagent ships. |
| 2 | Exploration lineages | A detached Node engine per lineage. One `claude -p` per role message, `--session-id` first and `--resume` after. Every side effect is a memoized op in a journal, so resuming after a crash, stop or infra pause runs the same code path as normal progress. RSIAgent semantics are kept: wave barrier with serial consolidation in authored order, unscored branch restart from immutable fixtures, practice candidates replayed at the Actor's own project root, mandatory fresh target retry after practice, STALLED buys one final test, escalation with an asymmetric Verifier swap, Phase-3 FAIL → same-Actor repair, and infra as a separate outcome class that pauses instead of failing. |
| 3 | Continuation and handoff | A segment is one `claude -p` invocation; `actions` is the number of top-level `tool_use` blocks. The reply is the **final assistant message**, never `result.result`. Three consecutive actionless segments without a valid handoff (or 24 segments) are transport infra. A `max_tokens` stop gets a truncation continuation; it is not counted as actionless, and it resets the counter when it ran tools. Handoff tokens are unique standalone lines outside code: `VERDICT:`, `STATUS: SUBMIT`, `DECISION:`; a heading marker, a bold or italic label or value and one trailing period are tolerated, list items, quotations and code never count. A near-miss line gets a syntax-only continuation that names it. Phase-1 waves use a fenced JSON envelope. |
| 4 | Isolation | Every child runs with `--restricted --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --permission-mode dontAsk --tools <explicit>` and a per-invocation `--settings` file: permission rules and `additionalDirectories`, a fail-closed role guard that never emits `allow`, a UserPromptSubmit digest filter that also proves the hooks ran, a sandbox block only in sandbox mode (`failIfUnavailable: true`), and forwarded auth/provider keys. The environment is allowlisted; Actor, Verifier and Curriculum children get their own `TMPDIR`. The running plugin code is read-only for every role. Without an OS sandbox the interactive Verifier degrades explicitly to `rollback`; lineages refuse unless `--allow-unconfined`. |
| 5 | Memory store | `~/.cc-rsi/projects/<key>/store` (not `CLAUDE_PLUGIN_DATA`, which is wiped on uninstall). The dsh-rsi store with additions: external draft directories, two-step commit with a pending marker, journal, history snapshots, a fenced lease lock with guarded takeover, freeze with hash check, sealed marker, 8-word shingle quarantine, UTF-8-ordered `tree_sha256` byte-compatible with RSIAgent, canonical tamper detection, crash-recoverable conflict rebase. The main Actor reads a read-only materialized view, never the canonical tree. |
| 6 | Tool surface | MCP server `rsi` with five tools: `submit`, `wait_verdict`, `learn`, `memory_commit`, `status`. Calls are bound to the calling session by PreToolUse attestation keyed by `tool_use_id`, matched against `params._meta["claudecode/toolUseId"]`. Role children get no MCP; their memory is a directory. |
| 7 | Hooks | One dispatcher `hooks/hook.mjs`: SessionStart (protocol, memory inventory, notices, shim, plugin-code fingerprint and saved plugin options, recovery of dead jobs and of checkpoint-open workspace locks), UserPromptSubmit (verbatim capture of user-authored requests, task bookkeeping, S0 baseline), PreToolUse (private-path, plugin-code, Verifier-transcript and lock guard; scheduled-prompt ledger for CronCreate/ScheduleWakeup/RemoteTrigger; MCP attestation, which first reads the session model from the transcript), PostToolUse (async rewake), Stop (nudge as `additionalContext`, gate as `decision: block`), PostModelSwitch (model tracking), SessionEnd (mark ended). Main-session hooks fail open. Role-child hooks (`hooks/role-guard.mjs`) are installed only through `--settings` and fail closed. |
| 8 | Entry points | Skills `/cc-rsi:status`, `/cc-rsi:explore`, `/cc-rsi:memory`, `/cc-rsi:freeze`, `/cc-rsi:doctor`; each runs the CLI with `--report-exit`. No commands, agents or workflows; no unfreeze or eval skill. `bin/cc-rsi` is the CLI; the `<home>/bin/cc-rsi` shim runs it from a terminal. Sealed evaluation runs from a terminal only and prints the score only to a TTY. Human-only subcommands refuse under `CLAUDECODE` and print the terminal command line, and the main guard denies them to model Bash. |
| 9 | Prompts | `prompts/*.md` templates with `{{NAME}}` placeholders, rendered by `lib/prompts`. The texts are RSIAgent's, as dsh-rsi neutralised them. RSIAgent's JSON action protocol is replaced by native tools; publication is the final message. The live Verifier's mechanics text names what its checkpoint restores (`full`, `listed` or `detect`). Each lineage snapshots its templates. |
| 10 | Configuration | Three `userConfig` keys (`verifier_model`, `stop_policy`, `sandbox`). Hooks read saved options from `CLAUDE_PLUGIN_OPTION_*`; the MCP server applies the options SessionStart recorded; the CLI reads them from `pluginConfigs` in the user settings. JSON config in `~/.cc-rsi/config.json` (global) and `<project>/.claude/cc-rsi.json` (project). Security keys are global-only; isolation keys may only be tightened by the project file. Defaults live in `lib/core/config.mjs`. |
| 11 | Testing | `node:test` units per module; a fake `claude` that emulates stream-json, session semantics, crashes, hangs and executes `--settings` hooks; a crash matrix over the op journal; hook tests with synthetic stdin; MCP protocol tests; `claude plugin validate . --strict`; an opt-in real `--model haiku` smoke. |
| 12 | Honesty | Every remaining difference from RSIAgent is listed below. Every verdict and lineage record states the isolation actually used. |

### Claude Code behaviour the decisions rely on

- `--session-id` is honoured and `--resume` keeps the context and the id. A child started without `--session-id` inherits the outer session id and appends to the outer transcript, so every context mints a fresh uuid and an id is never reused (reuse fails with "already in use"). `--resume` finds a session id in any project transcript directory.
- `--restricted` keeps OAuth working and confines file tools to the working directories, but ignores user settings files; auth and provider keys are therefore forwarded explicitly.
- `--setting-sources ""` drops project settings, `.mcp.json` and `CLAUDE.md`; settings-file hooks still fire under `--restricted`.
- A PreToolUse `allow` overrides `dontAsk`, so role hooks never emit `allow`. Permission deny rules are applied before PreToolUse hooks.
- `--tools`, `--add-dir` and `--allowedTools` are variadic, so the prompt always goes on stdin and directories and rules go into the settings file.
- Main-conversation MCP calls move to the background after about 120 s (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`); waits are therefore bounded by a budget counted from the arrival of the call.
- `CLAUDECODE=1` is set in every Claude Code subprocess, including skill `!` injection and the Bash tool; the CLI uses it to refuse human-only actions.
- Plugin agents ignore `permissionMode`, `hooks` and `mcpServers` and inherit the session's permission mode, so a subagent Verifier would surface its Bash prompts in, and widen, the main session. That is why the Verifier is a headless child.
- The UserPromptSubmit payload names who authored a prompt in `source`: `user`, `sdk`, `system` (peer and channel messages, task notifications, auto-continuation), `loop_wakeup`, `schedule_wakeup` (CronCreate, routines) and `poll_event`; payloads may omit it. Scheduled prompts arrive as raw text (2.1.296 has no `<scheduled-task` prefix).
- Hooks receive `CLAUDE_PLUGIN_OPTION_*` only for options the user saved; the MCP server's environment gets the manifest default substituted for an unsaved option. Saved options live in the user settings under `pluginConfigs["<plugin>@<marketplace>"].options`.
- The 2.1.296 SessionStart payload carries no model and PostModelSwitch fires only on `/model`; the transcript's assistant records carry `message.model`.
- Stop `additionalContext` continues the conversation under the same loop protections as `decision: block`, but is shown as "Stop hook feedback"; `decision: block` raises a "Stop hook error occurred" notification.
- A skill whose `!` command exits non-zero is aborted before Claude sees the skill body.
- Transcript directories are named by Claude Code's slug rule (non-alphanumerics become `-`; a name over 200 characters is cut and suffixed with a hash).

## Process model

```
 user terminal                    Claude Code main session (= interactive Actor)              ~/.cc-rsi  (= $CC_RSI_HOME)
 ─────────────                    ──────────────────────────────────────────────              ───────────────────────────
 cc-rsi explore start|stop|…      hooks/hook.mjs  session-start · prompt · guard ·             projects/<key>/store        canonical memory, journal,
 cc-rsi eval run   (TTY only,       attest · rewake · stop · model · session-end                                          history, reports, frozen/sealed
   refuses under CLAUDECODE)      mcp/server.mjs "rsi": submit · wait_verdict · learn ·        projects/<key>/sessions/<sid>  task.json, requests, jobs,
 cc-rsi doctor --live               memory_commit · status                                                                checkpoints, displaced, verdicts
        │                                │ spawn detached                                     projects/<key>/views/<sid>/memory  read-only Actor view
        │ spawn detached                 ▼                                                    projects/<key>/drafts/<episode>     interactive learning
        ▼                      lib/interactive/verify-job.mjs  (one inspection per job)       projects/<key>/lineages/<id>        records, op journal
 lib/engine/daemon.mjs <dir>             │                                                    projects/<key>/sealed/<lineage>/<run>
        │                                │                                                    work/<key>/<id>/   role cwds: projects/, actor-private/,
        └───────────────┬────────────────┘                                                                       curriculum-private/, verify*/
                        ▼                                                                     vscratch/<verifierSessionId>/   interactive Verifier scratch
     lib/runtime/context.mjs → child.mjs:  claude -p   (one process per role message)         run/{att,locks,settings,prompts,policies,sessions}/  bin/cc-rsi
        --session-id|--resume --restricted --setting-sources "" --strict-mcp-config --mcp-config {"mcpServers":{}}
        --disable-slash-commands --append-system-prompt-file <role> --settings <per invocation> --permission-mode dontAsk
        --max-turns N --tools <explicit>        stdin = the message      env = allowlist + CC_RSI_ROLE + own TMPDIR …
        hooks (via --settings): hooks/role-guard.mjs prompt | tool | post | pin
```

- The main session never runs a Verifier inline. Role children are spawned only by verification jobs, lineage engines and `cc-rsi doctor --live` (plus the one-call auth probe at lineage start).
- Jobs and engines are detached process-group leaders with stdio redirected to log files. They outlive the MCP server and the session, write their own state atomically, and clean up their own checkpoints. Children share the leader's process group. Shutdown sends SIGINT, waits, SIGTERM, waits, then SIGKILL.
- A job records its pid, a process start token (Linux: boot id and start time from `/proc`; elsewhere the `ps` start time), its host and a machine id (`lib/core/machine.mjs`: a digest of `/etc/machine-id`, else a random id in `<home>/run/machine-id`), so a reused pid or a renamed host is never mistaken for the job.
- `lib/runtime/child.mjs` is the only module that spawns `claude` (enforced by `test/plugin/boundaries.test.mjs`). Hooks never spawn `claude`; they start job recovery, workspace-lock recovery and the S0 baseline only as detached processes by file path.
- Recursion is closed: the CLI, engine and job refuse when `CC_RSI_ROLE` is set; the role guard denies `claude`, `cc-rsi` and `npx @anthropic-ai/claude-code`; children's `PATH` excludes the cc-rsi bin directories.

## Trust boundaries

Each boundary is enforced by the modules in brackets.

1. **Roles hear only the harness.** Child stdin is owned by the job or engine. A role child's UserPromptSubmit hook blocks any prompt whose sha256 differs from `CC_RSI_EXPECT`, and a passing entry in the guard log is mandatory: a child whose hooks did not run is infra `hooks_not_run`. An interactive Verifier context is resumed only when its transcript files match the fingerprint (path, size, sha256, link flag of every `<config>/projects/*/<id>.jsonl`) recorded after its last job; otherwise it is retired (`ROLE_CONTEXT_RETIRED`) and a fresh context starts with the stored reports, so an edited history never becomes the Verifier's own conversation. [`hooks/role-guard.mjs prompt`, `lib/runtime/stream.mjs`, `lib/runtime/classify.mjs`, `lib/interactive/task.mjs transcriptFingerprint`, `lib/mcp/tools.mjs submit`, `lib/interactive/verify-job.mjs inspect`]
2. **Verdicts are harness-owned.** The Verifier's final assistant message is parsed by the job or engine. Verdict state is written only by the job (interactive) or the engine (lineages), under `~/.cc-rsi`. Everything under `~/.cc-rsi` and an external `memory.dir` store, except the read-only view, the shim and the open learning draft, is denied to the Actor's file tools and to its Bash commands (path tokens, globs, tree walks rooted above, `sh -c`/`eval` strings). Reports are content-addressed and re-hashed on read. [`lib/runtime/stream.mjs`, `lib/protocol/tokens.mjs`, `lib/hooks/guard.mjs`, `lib/guard/bash.mjs`, `MemoryStore.getReport`]
3. **The Verifier is blind to the Actor's narrative.** It receives the user's messages (interactive: prompts whose `source` is `user` or `sdk`; synthetic turns and prompts the session scheduled for itself are never captured) or the task text (lineages), mechanical change facts computed by the harness, its own prior reports (or another Verifier's, labelled as such), and evidence leads only as formatted `LEAD` blocks. `verifierCharter` throws on anything else. Leads are never executed by the harness. Every role child is denied the Actor's transcripts, plans, task lists, file history, prompt history and session temp directories, and the Actor is denied the Verifier's transcript directory. [`lib/interactive/requests.mjs`, `lib/prompts/roles.mjs`, `lib/protocol/leads.mjs`, `lib/runtime/private.mjs`, `lib/hooks/guard.mjs`]
4. **Infra is a separate outcome class.** Every invocation is classified before any parse. Infra never becomes PASS or FAIL, never enables `learn`, and never commits memory. [`lib/runtime/classify.mjs`, the job and engine code paths]
5. **Sealed evaluation runs outside every model context.** CLI-only; refuses under `CLAUDECODE` or `CC_RSI_ROLE`; prints the score only to a TTY; keeps records under hidden `~/.cc-rsi` paths; never starts the evaluator on a candidate with links leaving it; gives the evaluator a `TMPDIR` inside the hidden run directory; `--json-out` refuses model-visible destinations, compared lexically and physically. [`lib/sealed/eval.mjs`, `lib/cli/eval.mjs`, `lib/hooks/guard.mjs`]
6. **Memory changes only through commits.** Canonical memory is never exposed writable. The tree hash is compared with the last journal `treeAfter` at every sensitive step (SessionStart warns; `learn`, `memory_commit`, commits, lineage starts, resume admission, waves, target and practice steps refuse or pause). Lock-free integrity reads treat an install in flight (the pending marker's `treeAfter`) as intact. The Actor's view always shows committed memory: on tamper the view is materialized from the last committed history snapshot. [`MemoryStore.assertCanonicalIntact`, `storeIntegrity`, `lib/interactive/memview.mjs`]
7. **Human-only operations need a human.** Unfreeze, restore, accept-external, import, draft pruning, abandon, lock release, verification cancel and sealed evaluation refuse under `CLAUDECODE` (exit 65, printing the command line to run in a terminal), and the main guard denies them to model Bash. Lineage start and resume are denied to model Bash unless the global `exploration.modelMayStart` is set. [`lib/cli/main.mjs`, `lib/hooks/guard.mjs`]
8. **The code that judges is the code the session started with.** SessionStart records a sha256 over the plugin's `lib`, `hooks`, `bin`, `mcp` and `prompts`. `submit` refuses (infra `plugin_changed`, no job) and the job finishes as `plugin_changed` (no lock, no Verifier) when the code changed; the engine compares the code with the lineage baseline (and accepted drift) before every real role spawn and pauses `plugin_changed`. The main guard makes the plugin roots read/exec-only for the Actor, and every role gets them as read-only roots for its file tools and, in sandbox mode, as sandbox `denyWrite` (an unsandboxed role's Bash is only detected, by the fingerprint checks). Not enforced when the session's project is, or lies inside, the cc-rsi checkout the plugin runs from. [`lib/interactive/session.mjs pluginCodeFingerprint`, `lib/mcp/tools.mjs`, `lib/interactive/verify-job.mjs`, `lib/engine/records.mjs pluginDrift`, `lib/engine/roles.mjs`, `lib/hooks/guard.mjs`]

## State machines

### Interactive task (`task.json`, `lib/interactive/task.mjs`)

`task.json` is changed under the session lease lock, which hooks hold for at most 5 s; a writer whose lease was taken over writes nothing (`assertHeld`, `lock_lost`). A task carries the Verifier context (`ctxKey`, session id, model, transcript fingerprint, `retired`), a generation counter, its reports (each with the Verifier model that published it), the last verdict and whether it was learned. An unlearned terminal task is kept as `prevTask` when a new one opens, so it can still be learned. The state also holds the append-only `verifierSessionIds` and `verifierCandidateRoots` that the guard uses to hide Verifier transcripts.

| Event | Guard | Effect |
|---|---|---|
| UserPromptSubmit | a user-authored prompt (`source` `user`/`sdk` when present; no synthetic prefix such as task notifications, teammate or channel messages, slash commands; not a prompt this session scheduled for itself); no learning phase; no job; and no task, a closed task or a `PASS` task | `openTask`: `taskSeq++`, record the status digest and spawn the S0 baseline; an unlearned PASS/FAIL task becomes `prevTask` |
| `submit` | a job is running | behaves like `wait_verdict` |
| `submit` | a learning phase is open | refused (`learning_open`, with the learn/abandon hint) |
| `submit` | an undelivered verdict of the current generation still covers the workspace | delivered instead of a redundant inspection |
| `submit` | the plugin code changed since SessionStart (not developing cc-rsi) | refused, infra `plugin_changed`; no job, no state change |
| `submit` | no task, a closed task, a different candidate root, or a `PASS` task with a newer request | `openTask` first (covers sessions whose prompt hook did not run) |
| `submit` (accepted) | — | set the candidate root, `generation++`, pick the Verifier context (reuse it unless retired, the model changed, idle > `verifierIdleHours`, or its transcript no longer matches the recorded fingerprint; otherwise a fresh context seeded with prior reports, handed over as another Verifier's when one was published under a different model), append its id and root to `verifierSessionIds` / `verifierCandidateRoots`, write the job file (with the plugin fingerprint), spawn the job |
| job result: verdict | the job's task is `task` or `prevTask` | push the report; set `lastVerdict`; `learned = false`; record the Verifier session and its transcript fingerprint; clear the job |
| job result: infra | — | clear the job; no verdict; refresh the transcript fingerprint; retire the Verifier context on `context_overflow` or a lost established transcript |
| `learn` | a terminal, unlearned, current (status digest unchanged) verdict; `mode: learn`; memory not frozen, sealed or tampered | open a draft at `drafts/<episode>`; `learning = {stage: distill, code}` (a repeated `learn` re-shows the current stage and code) |
| `memory_commit` | `confirm` equals the current code | `distill` → `reconcile` (new code); `reconcile` → commit: promoted marks the task learned and closed; `limit` → condense with a new code; `conflict` → rebase the draft, new code; quarantine is neutral |
| `memory_commit({abandon: true})` | a learning phase is open (no code needed) | discard the draft; the task counts as handled |

Each stage message carries a fresh 6-hex confirmation code, so the Actor can only advance after reading the stage instructions; no transcript parsing is needed. After a compaction or resume with an open phase, SessionStart tells the Actor to call `learn` (the code itself is never injected).

### Verification job (`lib/interactive/verify-job.mjs`)

```
queued ──spawn──▶ running ──▶ done   (result: verdict, report sha, restored/displaced paths, isolation, model, digests,
                     │                  notCurrent, transcript fingerprint)
                     └──────▶ infra  ({cls, detail}: plugin_changed, workspace_busy, checkpoint_failed, store_unavailable,
                                       sandbox_required, candidate_changed_during_inspection, auth, config,
                                       transient_exhausted, restore_failed, cancelled, job_died, …)
```

1. Write `running` (pid, start token, host, machine id), start a 5 s heartbeat.
2. Compare the plugin fingerprint SessionStart recorded (copied into the job file by `submit`) with the code on disk (mismatch → `plugin_changed`, nothing else runs).
3. Take the project-wide workspace lock for the candidate root (held by another live job → `workspace_busy`). The lock is fenced: if it is taken over during the inspection, the inspection is aborted and recorded as `workspace_busy`, never as a verdict.
4. Record the status digest, mark the lock record `checkpointOpen` (before the checkpoint exists), then take the checkpoint: git-listed plus untracked-not-ignored files; outside git a walk that skips `.git`, `node_modules`, `.venv`, `__pycache__`, refuses the user's home and `/`, and fails closed past `walkMaxFiles`; detect-only above the size caps.
5. Build the mechanical context: workspace facts, the S0 baseline delta, and `CHANGED SINCE YOUR LAST INSPECTION`.
6. Decide isolation (`sandbox`, `rollback`, or refuse under `require`).
7. Send the charter on the task's Verifier context and continue in the same context until a valid `VERDICT:` line. Right before `--resume` the transcript fingerprint is compared again; on a mismatch the context restarts with a new uuid and the stored reports. The mechanics paragraph names the checkpoint coverage (`listed` or `detect`).
8. Always restore the checkpoint, also after infra, moving displaced versions aside, then clear `checkpointOpen`. A path that appears during the restore is never replaced (files are hard-linked into place, links created in place; a newcomer is displaced and the install retried) and is reported `unstable`. A failed restore keeps the lock with `restoreFailed: true` (fail closed), or writes a separate sticky marker when another job holds the record; only `cc-rsi doctor --release-lock` (human-only) releases it.
9. Judge what the restore found: in sandbox mode any changed path means something outside the inspection changed the candidate (infra `candidate_changed_during_inspection`, no verdict); in rollback mode a `PASS` whose restore had to put back or saw pre-existing paths change is recorded with `statusDigest` `not-current:<digest>` and `result.notCurrent`, so status, Stop, `learn`, delivery and the CLI never treat it as current. An infra detail never claims "the candidate was restored" when a detect-only checkpoint or a re-changed path left changes behind; it lists them.
10. Store the report, write the job result, apply the task transition, append `verdicts.jsonl`, release the lock, then write the final status.

**Recovery.** SessionStart, `submit`, `wait_verdict` and `status` spawn `verify-job.mjs recover` for any job of the session whose process is gone. A job is gone when its pid is dead on this machine, or when the pid's start token differs from the recorded one; a fresh heartbeat (≤ 30 s) means alive; with identity unknown, a command-line check applies, then a heartbeat older than 10 minutes. A lock whose holder died with `checkpointOpen` stays live (`recoveryPending`) until its recovery ran, and whoever meets it starts that recovery: the main guard (denying with "its recovery is running, retry shortly"), every SessionStart (any session), MCP `status`, `acquireWorkspaceLock` and `doctor`. The recovery takes the lock over by compare-and-swap, restores the checkpoint under it, records infra `job_died` ("this is not a verdict", listing paths not rolled back), clears the task's job and releases the lock. When another job holds the root or a restore-failed marker exists, nothing is restored: the checkpoint is kept and the job records `restore_failed`. A recovery whose own lock is taken over records nothing. A job that recorded its verdict before dying is finished as `done`.

### Lineage status (`state.json`, `lib/engine/daemon.mjs`)

```
starting ──▶ running ──┬──▶ completed     (result.json written in the final op)
                       ├──▶ quarantined   (audit hit; absorbing)
                       ├──▶ paused_user   (SIGTERM / explore stop)        ──explore resume──▶ running
                       └──▶ paused_infra  (InfraError: cls + pausedAt op)  ──explore resume──▶ running
any non-terminal status, engine not live ──explore abandon──▶ abandoned  (result.json termination "abandoned")
```

The daemon exits 0 when it completes, pauses or quarantines, 3 when another engine holds the lineage's lease or its own lease was taken over (`lock_lost`: it aborts and writes neither the journal nor the state), 64 inside a role context and 1 on an unexpected error. A lineage marked `running` whose engine died is continued with `explore resume`; the stale lease is taken over. Before every real role spawn (never on replay) the engine checks the plugin code against the lineage's baseline and the last accepted drift, and pauses `paused_infra` with `plugin_changed`.

`explore resume` runs a write-free admission (`admitResume`), then `applyResume` grants overrides for the paused op when it ends in `/liveness@n` (one stall continuation), `/unverified@n` (one more practice evidence round) or `/commits@n` (four more commit attempts). Accepted drift re-snapshots the prompts and is recorded in `lineage.json` (`lock.driftAccepted`, with `promptsRefreshed`). Any other pause re-runs the pending op in recovering mode: the same session plus a recovery note that embeds the original message.

### Op journal and determinism (`lib/engine/journal.mjs`)

Every side effect of a lineage is an op `j.op(key, kind, args, fn)` recorded in `ops.jsonl` (fsync per line; large results in `blobs/`):

- a `done` record replays its recorded result (a different `kind` or `argsSha` throws `ReplayDivergence`);
- a `start` without `done` re-runs `fn` in recovering mode;
- otherwise `start`, run, `done`.

Every append is fenced by the engine lease (`fence: lock.assertHeld`), so no record is written after the lease was lost.

Determinism rules: every role send, filesystem write, store mutation and protocol event is inside an op, and so is every filesystem or store observation that steers control flow (shape gates, authoring listings, wave and decision validation, manifest and fingerprint comparisons, tamper checks, audit results, commit outcomes). Uuids are generated only inside ops; configuration, models, prompts and isolation come from `lineage.json` and the prompt snapshot; counters are recomputed from recorded results.

Concretely:

- each fixture capture happens inside the same recorded op that validates the Curriculum's handoff, so a recorded valid handoff always has its immutable captures, even if the authoring tree is deleted before a resume;
- each protocol event is idempotent by op key, and terminal events are written just before the `final` op;
- each role message is a memoized `send` op: a recovering send re-sends the message inside a recovery note in the same session, and a session that never started is restarted with a new uuid (never reusing the old id);
- a branch abandon that started is completed through the same op before the next attempt (`hasStart`), and the abandon is idempotent (it puts back an Actor tree an interrupted inspection left aside).

The crash matrix (`test/engine/crash-matrix.test.mjs`) throws or SIGKILLs at every op of a reference broad run, a broad run whose branch restarts unscored, and a reference deep run, including SIGKILL in the middle of a role message and workspace mutation before resume, and checks that `result.json`, the memory tree hash and the committed episode list equal the uninterrupted run. `CC_RSI_CRASH_MATRIX=full` also faults at every `start` record and adds a deep run with a practice project.

### Phase 1: broad waves (`lib/engine/broad.mjs`)

```
init: assert memory intact; LINEAGE_STARTED; one Curriculum context for the whole lineage
for each wave W:
  projectsDone ≥ broadProjectBudget or cost ≥ maxCostUsd → budget_exhausted   (checked only between waves)
  prep: refresh the Curriculum's read-only memory copy; empty authoring/
  Curriculum handoff: wave envelope (≤ waveCeiling ids) + every authoring/<id> passes the shape gate → captured
  audit Curriculum text, notes and fixtures (shingle tripwire) → hit = quarantined
  SATURATED | STALLED → finish (saturated | stalled)
  snapshot canonical memory for the wave
  run every branch in parallel (waveConcurrency): fresh Actor on a replay of its fixtures + read-only memory snapshot,
      then a fresh Verifier on a fresh replay of the captured candidate at the Actor's own project root
      (the Actor's tree moved aside, put back by op <K>/restore; exactly one inspection, no UNVERIFIED)
      retryable infra before a report → move the attempt aside, restart unscored from fixtures (branchRetries)
  BARRIER: all branches settle; any rejection → WAVE_BLOCKED, no commits, pause
  for each branch in authored order: same Actor distills → reconciles → commit on the LATEST canonical memory
```

### Phase 2: deep target/practice (`lib/engine/deep.mjs`, `lib/engine/target.mjs`)

```
for cycle c:
  a = targetAttempt(fresh Actor, unchanged target, snapshot of canonical memory)
  finalAfterBudget → budget_exhausted
  PASS and no Curriculum review (stopPolicy verifier_pass, or after a STALLED) → verifier_pass
  finalAfterStall → curriculum_stalled_final_target_test
  UNVERIFIED → target_harness_unverified
  targetCycleBudget reached → budget_exhausted
  Curriculum loop (one Curriculum context for the lineage; curriculumDecision reset per evolution):
    practice or cost budget reached → budget_exhausted if no practice this evolution, else one final target attempt
    decision: PROJECT (body contains <PROJECT_ROOT>, practice/authoring passes the shape gate → captured)
              → practice project (Verifier on a replay at the Actor's root; may answer UNVERIFIED; evidence
                rounds, unverifiedRounds → pause unverified_exhausted) → same Actor learns, with diagnosis
            | READY_FOR_TARGET → break | STALLED → finalAfterStall, break
  PASS with no practice this evolution → verifier_pass_curriculum_ready | verifier_pass_curriculum_stalled
  otherwise → MANDATORY fresh target attempt
finish: final candidate = the verified copy when the last attempt was learned, else its root (nothing ran after the
        verdict); candidate_changed_after_verdict recorded
```

**Target attempt** (shared by deep and frozen):

```
Actor work → STATUS: SUBMIT + shape gate → protected live inspection (checkpoint, Actor memory removed, restore if changed)
  PASS → terminal
  FAIL → terminal (deep) | same-Actor repair, same Verifier (frozen; ≥ frozenRepairRounds → stall)
  UNVERIFIED → evidence leads from the same Actor; the round counter resets when the evidence (or a frozen repair)
               took tool actions; ≥ unverifiedRounds in a row → stall; ≥ unverifiedCeiling in one context → stall
stall (Actor liveness or round limit) → one forced inspection
  PASS, or FAIL in deep → terminal, learned by the same held Actor
  otherwise, while resumes < targetResumes: synthesize a work log (summarizer, or a digest fallback),
      strategy review when the root did not change, resume in a FRESH Actor context (frozen: the frozen
      runtime boundary and scratch kept, no learning promised)
      with escalation: Actor model := escalation; if escalation equals the Verifier model, the Verifier is swapped
      once to the original Actor model with no history and no prior reports, and told it is a fresh Verifier
      context on a different model
  else → UNVERIFIED (or FAIL in frozen), not learnable
terminal (deep): capture the verified candidate (priv/<T>/verified-candidate, with the root fingerprint)
  → distill → reconcile → diagnosis → commit (≤ 4 attempts; limit → condense, conflict → rebase)
```

A Verifier FAIL never triggers a fresh-context pivot; only stalls do. Verifier transport infra is not a stall: the lineage pauses.

### Phase 3: frozen lineage (`lib/engine/frozen.mjs`)

Requires a frozen, intact store. One target attempt with `frozen: true` (FAIL → same-Actor repair; no learning; no Curriculum). The final op re-asserts the frozen tree (mismatch → infra `memory_frozen_tamper`), captures the final candidate and writes `result.json` with `frozen_tree_sha256`, `candidate_changed_after_verdict: false` and `official_evaluator_calls: 0`. Sealed evaluation is a separate, terminal-only step.

### Sealed evaluation (`lib/sealed/eval.mjs`)

Refuse (inside Claude Code; no evaluator; lineage not a finished deep/frozen lineage; live engine; candidate changed; `--json-out` inside the project, a worktree, the work trees, Verifier scratch, the candidate or the run directories) → freeze if needed and assert frozen-intact → copy the final candidate per attempt → block without running the evaluator when the capture was `unsafe` or the copy holds a link leaving the tree → run the evaluator (cwd = the copy, `TMPDIR` = `<run>/tmp`) with retries and the identical-error limit → re-assert frozen-intact → mark the store sealed → write `evaluation.json` and the lineage's `sealed.json` (no score) → print the score only to a TTY. While the store is sealed, learning refuses until `cc-rsi memory unfreeze --after-sealed`.

## Invariants

- **Infra ≠ verdict.** An infrastructure outcome never becomes PASS or FAIL, never opens learning, never commits memory, and is never terminal for a lineage (it pauses).
- **A verdict covers only the tree that was inspected.** A sandboxed inspection whose candidate changed from outside yields no verdict; a rollback-mode PASS during which pre-existing paths changed is never current; a deep lineage's final candidate is the tree the Verifier judged, captured before learning.
- **Readiness ≠ correctness.** `READY_FOR_TARGET` is recorded as `curriculum_decision`, never as a verdict. Any practice forces a fresh, unchanged-target attempt; `STALLED` buys exactly one final target test; exhausted budgets end `budget_exhausted`, never as convergence.
- **UNVERIFIED is never learned.** Only PASS and FAIL are terminal for learning.
- **Learning is serial and on the latest memory.** Wave consolidation runs in authored order after the barrier; every commit checks the draft's base hash and rebases on conflict; an episode is never committed twice (idempotent by episode and origin); an interrupted rebase is finished from the intent recorded in the draft meta, and an Actor's draft or `.prev` is never deleted while its owner lives.
- **Memory changes only through commits**, and only through the store: limits, audit, conflict check, atomic install with a pending marker, journal record with tree hashes before and after, history snapshot. A change to frozen memory is never accepted; only the frozen tree's own snapshot can be restored.
- **Locks are fenced.** Stale-lock takeover is a guarded compare-and-swap; a holder whose lease was taken over notices it (`lost`, `onLost`, `assertHeld`) and writes nothing: no store install, no `task.json`, no journal record, no job record.
- **Sealed isolation.** No model context sees an evaluation score; the evaluator runs on a copy without outward links; frozen memory is verified before and after; a sealed store closes learning until a recorded human override.
- **The workspace is restored.** Every interactive inspection restores its checkpoint (also after infra), never deletes a pre-existing or ignored file, never replaces a file that appeared during the restore, and keeps displaced versions; a failed restore keeps the workspace locked, and a job that died with its checkpoint open keeps it locked until its recovery restored it.
- **The judging code is the session's code.** No verdict is produced by plugin code that changed after SessionStart (interactive) or after the lineage baseline without an accepted drift (lineages).
- **Session ids are never reused.** Every context mints a fresh uuid; `--resume` is used only for a session this context created, and for an interactive Verifier only while its transcript fingerprint matches.
- **The role guard never emits `allow`** and fails closed on any error; a child whose hooks did not run is infra.
- **Every record states its isolation** (`sandbox` | `rollback` for interactive verdicts, `sandbox` | `unconfined` for lineages), and the Verifier's mechanics text is rendered from the actual mode and checkpoint coverage (`full` for lineage targets, `listed` or `detect` interactively).

## Module map

Entry points:

| Path | Role |
|---|---|
| `bin/cc-rsi` | CommonJS shim: Node ≥ 18 and role-context checks, then dynamic import of `lib/cli/main.mjs` |
| `hooks/hooks.json` | Main-session hook registrations (the PreToolUse guard matcher includes CronCreate, ScheduleWakeup and RemoteTrigger) |
| `hooks/hook.mjs` | Main-session hook dispatcher → `lib/hooks/<sub>.mjs` |
| `hooks/role-guard.mjs` | Role-child hook (`prompt`, `tool`, `post`, `pin`), installed only via `--settings`; imports only `lib/core` and `lib/guard` |
| `mcp/server.mjs` | MCP server entry → `lib/mcp/server.mjs` |
| `.mcp.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin manifests |
| `skills/{status,explore,memory,freeze,doctor}/SKILL.md` | Skills; each runs `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" … --report-exit` via `!` injection |
| `prompts/*.md` | Role, charter, continuation, learning and guidance templates |
| `scripts/run-tests.mjs` | Test runner (explicit file list; node options keep their values; `test/e2e` only with `CC_RSI_E2E=1`) |

`lib/core` (shared primitives; imports only `node:*` and siblings):

- `lib/core/paths.mjs` — home, global/project/session/lineage layouts, project key, safe names.
- `lib/core/config.mjs` — defaults, layered loading, global-only and tighten-only rules, validation, userConfig mapping.
- `lib/core/atomic.mjs` — atomic file writes and JSON reads, directory fsync, `ensureDir`, `rmrf`.
- `lib/core/jsonl.mjs` — fsync'd JSONL appends that tolerate a torn tail.
- `lib/core/lock.mjs` — cross-process lease lock (dsh store lock) with a guarded compare-and-swap takeover (`compareAndDelete`, `compareAndReplace`), fencing (`lost`, `onLost`, `assertHeld`), and `withLock`.
- `lib/core/machine.mjs` — stable machine id and `sameMachine`.
- `lib/core/ids.mjs` — uuids, job/lineage/episode/run ids, confirmation codes, validators.
- `lib/core/digest.mjs` — sha256 helpers and canonical JSON with UTF-8 key order.
- `lib/core/proc.mjs` — zombie-aware `pidAlive` and `groupAlive`, `spawnDetached`, `killGracefully`, `runCapture`.
- `lib/core/log.mjs` — file logger (JSONL, never stdout, never throws).
- `lib/core/errors.mjs` — `CcRsiError`, `UsageError`, `LockTimeoutError`, `HumanOnlyError`, `RoleContextError`.

`lib/memory` (the store):

- `lib/memory/hash.mjs` — `canonicalJson`, `treeSha256`, `manifestSha256`; byte-compatible with RSIAgent.
- `lib/memory/safe-path.mjs` — safe relative memory paths.
- `lib/memory/tree.mjs` — scan, pull and write memory trees (regular files only; symlink, special-file and non-UTF-8 rejection); `replaceDir` with per-writer staging names and stale-sibling cleanup.
- `lib/memory/errors.mjs` — the `MemoryError` family with stable codes.
- `lib/memory/store.mjs` — `MemoryStore`: drafts, two-step commit, recovery, tamper detection, lock-free `storeIntegrity`, freeze, sealed marker, history, reports.
- `lib/memory/audit.mjs` — 8-word shingle leakage tripwire.
- `lib/memory/inventory.mjs` — inventory listing (names and sizes only).
- `lib/memory/view.mjs` — read-only views and writable copies of a memory tree.

`lib/protocol` (handoff parsing):

- `lib/protocol/tokens.mjs` — prose view and unique standalone `VERDICT:` / `STATUS: SUBMIT` / `DECISION:` tokens, tolerant of heading and emphasis markup, with near-miss details.
- `lib/protocol/wave.mjs` — Phase-1 wave JSON envelope.
- `lib/protocol/leads.mjs` — CLAIM/PROBE parsing (wrapper fences, list markers, bold labels, inline code), MCP lead validation, `LEAD` block rendering.

`lib/prompts` (texts):

- `lib/prompts/render.mjs` — template loading (plugin or lineage snapshot), strict `{{NAME}}` rendering, sections, snapshots.
- `lib/prompts/roles.mjs` — role prompt builders (systems, charters, continuations, learning stages, Curriculum and summarizer texts).
- `lib/prompts/guidance.mjs` — interactive MCP result texts (verdict, running, infra, refusals, commit results).

`lib/workspace` (files and git, never running repository-planted programs):

- `lib/workspace/copy.mjs` — tree copy (no `fs.cp`), byte-ordered bounded listing, removal, move-aside, write-bit helpers.
- `lib/workspace/git.mjs` — hardened git, project root via the git common dir, workspace facts, status digest, inert repo.
- `lib/workspace/checkpoint.mjs` — interactive checkpoint with displaced-copy restore that never replaces newcomers, persisted for cross-process recovery.
- `lib/workspace/fingerprint.mjs` — tree fingerprints, project manifests, change descriptions.
- `lib/workspace/fixtures.mjs` — shape gate, capture, replay, verify and read-only views of fixture and candidate trees.
- `lib/workspace/baseline.mjs` — S0 baseline at task open (bounded walk) and its delta; detached CLI entry.

`lib/guard` (heuristic guards shared by the role guard and the main guard):

- `lib/guard/paths.mjs` — physical path resolution, file-tool path extraction, search-root coverage.
- `lib/guard/bash.mjs` — Bash command scanning: hidden paths and tokens, brace expansion and globs, tree walkers rooted above a hidden root, `sh -c`/`eval` strings, redirections, recursion, mutation deny patterns.

`lib/runtime` (headless role children):

- `lib/runtime/errors.mjs` — `InfraError`, `TransportInfraError`, `InterruptedError`, retryable classes.
- `lib/runtime/claude-bin.mjs` — resolve the `claude` binary, its version and required flags.
- `lib/runtime/env.mjs` — child environment allowlist and never-pass list.
- `lib/runtime/auth-settings.mjs` — forwarded user-scope auth and provider settings.
- `lib/runtime/models.mjs` — model resolution chain and `effective()`.
- `lib/runtime/private.mjs` — the harness-private roots and tokens every role hides (shared by the interactive Verifier and the lineage roles).
- `lib/runtime/policy.mjs` — role policy JSON for the role guard.
- `lib/runtime/settings.mjs` — per-invocation `--settings` (permissions, hooks, sandbox, forwarded keys).
- `lib/runtime/argv.mjs` — the exact child command line.
- `lib/runtime/stream.mjs` — stream-json parsing and hook attestation.
- `lib/runtime/classify.mjs` — outcome classification table (first match wins).
- `lib/runtime/child.mjs` — spawn one invocation with watchdog and logs; the only module that starts `claude`.
- `lib/runtime/context.mjs` — `RoleContext`: one persistent session per role identity, transient retry, recovery note, sandbox degrade.
- `lib/runtime/converse.mjs` — same-context continuation loop with liveness and ceiling.
- `lib/runtime/sandbox.mjs` — static and live sandbox probes (inconclusive unless the probe command demonstrably ran), isolation decision.

`lib/interactive` (everyday mode state):

- `lib/interactive/session.mjs` — session context, `session.json`, project resolution and caching, the MCP option layer, the plugin-code fingerprint, the session model from the transcript.
- `lib/interactive/requests.mjs` — verbatim capture of user-authored requests (`source` filter, synthetic prefixes, scheduled-prompt ledger) and the Verifier's task messages.
- `lib/interactive/task.mjs` — task state machine, job-file helpers (process start tokens, liveness, recovery spawn) and Verifier transcript fingerprints.
- `lib/interactive/attest.mjs` — write, take and sweep MCP attestations.
- `lib/interactive/wslock.mjs` — project-wide workspace locks (sticky after a failed restore or while a checkpoint is open), restore-failed markers, takeover for recovery, `recoverPendingLocks`.
- `lib/interactive/verify-job.mjs` — the detached verification job (`run` and `recover`).
- `lib/interactive/memview.mjs` — refresh of the main session's read-only memory view.

`lib/mcp` (server `rsi`):

- `lib/mcp/jsonrpc.mjs` — newline-delimited JSON-RPC 2.0 over stdio.
- `lib/mcp/server.mjs` — MCP protocol handling, progress and cancellation; the version comes from `.claude-plugin/plugin.json`.
- `lib/mcp/tools.mjs` — the five tools, argument validation, wait budgets, status text.

`lib/hooks` (main-session hooks; fail open):

- `lib/hooks/common.mjs` — stdin parsing, output helpers, role no-op, fail-open wrapper.
- `lib/hooks/session-start.mjs` — record the session (fingerprint, saved options), refresh the shim and view, recover dead jobs and checkpoint-open locks, inject protocol, memory context and notices.
- `lib/hooks/prompt.mjs` — synthetic-prompt filter, request capture, task opening, baseline spawn.
- `lib/hooks/guard.mjs` — private-path, plugin-code, Verifier-transcript and workspace-lock guard, human-only Bash denial, scheduled-prompt ledger.
- `lib/hooks/attest.mjs` — MCP call attestation (after reading the session model from the transcript).
- `lib/hooks/rewake.mjs` — async rewake when a verdict lands (one wake per job).
- `lib/hooks/stop.mjs` — stop policy (`off` | `nudge` | `gate`).
- `lib/hooks/model.mjs` — track model switches in `session.json`.
- `lib/hooks/session-end.mjs` — mark the session ended.

`lib/engine` (exploration lineages):

- `lib/engine/journal.mjs` — memoized op journal with overrides, blobs and an append fence.
- `lib/engine/records.mjs` — preflight, creation, `lineage.json`/`state.json`/events/results, resume admission, plugin drift, abandon, show.
- `lib/engine/roles.mjs` — per-role specs (hidden roots, own `TMPDIR`, Actor scratch, read-only plugin code) and the journaled `EngineContext`, which checks the plugin before every real spawn.
- `lib/engine/steps.mjs` — journaled converse wrapper (with action counts) and free (learning) phases.
- `lib/engine/inspect.mjs` — protected practice (replay at the Actor's root) and target (live) inspections.
- `lib/engine/learn.mjs` — same-Actor learning: distill, reconcile, diagnosis, commit loop.
- `lib/engine/project.mjs` — practice projects with unscored restart and crash-safe abandon.
- `lib/engine/target.mjs` — target attempt: verified-candidate capture, stall, forced inspection, resume, escalation swap.
- `lib/engine/worklog.mjs` — work log synthesis and strategy review.
- `lib/engine/broad.mjs` — Phase 1 waves.
- `lib/engine/deep.mjs` — Phase 2 target/practice loop.
- `lib/engine/frozen.mjs` — Phase 3 frozen lineage.
- `lib/engine/daemon.mjs` — detached entry: lease (fenced), signals, plugin check, phase dispatch, pause and finish.

`lib/sealed` and `lib/cli`:

- `lib/sealed/eval.mjs` — sealed evaluation.
- `lib/cli/main.mjs` — argument parsing, dispatch, role and human-only refusals (with the terminal command line), `--report-exit`, saved plugin options, `version`, `engine run`, `verify cancel`.
- `lib/cli/status.mjs` — `cc-rsi status`.
- `lib/cli/doctor.mjs` — `cc-rsi doctor` checks (including `shim`), `--live` probes, `--release-lock`.
- `lib/cli/memory.mjs` — `cc-rsi memory …`.
- `lib/cli/explore.mjs` — `cc-rsi explore …`.
- `lib/cli/eval.mjs` — `cc-rsi eval run|show`.
- `lib/cli/gc.mjs` — `cc-rsi gc`.
- `lib/cli/shim.mjs` — the `~/.cc-rsi/bin/cc-rsi` terminal shim.

**Import boundaries** (`test/plugin/boundaries.test.mjs`):

- `lib/core` imports only `node:*` and itself; `lib/memory`, `lib/protocol` and `lib/workspace` add only `lib/core`.
- `lib/guard` imports only `lib/core`; `lib/prompts` imports `lib/core` and `lib/protocol`.
- `lib/runtime` imports only `lib/core`, `lib/guard`, `lib/prompts` and `lib/memory/hash.mjs`.
- Hooks import only a hot-path set (`lib/core`, `lib/guard`, `lib/prompts`, `lib/memory`, the interactive state modules, `lib/workspace/git.mjs`, `lib/runtime/{sandbox,models}.mjs`, `lib/cli/shim.mjs`), and their import closure never reaches `lib/engine` or `lib/runtime/{child,context}.mjs`. `hooks/role-guard.mjs` imports only `lib/core` and `lib/guard`.
- `lib/engine` never imports `lib/interactive`, `lib/mcp` or `lib/hooks`; `lib/interactive` never imports `lib/engine`.

## Remaining differences from RSIAgent

1. **No VM; isolation is narrower.**
   - Without bubblewrap/socat (many containers, WSL1) role children are confined only by `--restricted` file tools, permission rules, a heuristic Bash guard, and checkpoint/restore of tracked and untracked-not-ignored files.
   - Bash read-hiding, network egress control and process isolation are heuristic or absent.
   - RSIAgent uses QEMU rollback, namespaces and a private tmpfs scratch; cc-rsi gives each role its own `TMPDIR` and scratch directory but cannot hide other paths mechanically without a sandbox.
   - The sandbox, when present, wraps Bash only. Hooks, MCP and Claude Code itself run unsandboxed.
   - Every record states the mode actually used. Lineages require an explicit `--allow-unconfined` without a sandbox.
2. **Same OS user.** The Actor (the user's session) and every role share one uid. Forgery or reading by obfuscated Bash is possible. The guards stop accidents and casual access; tamper detection **detects** canonical-memory, report, Verifier-transcript and plugin-code changes. Neither prevents a determined adversary; an unsandboxed role (a lineage child, or the interactive Verifier in rollback mode) can still write the plugin code through Bash, which is detected before the next lineage role child or the next verification.
3. **Rollback scope.**
   - Interactive restore covers git-listed plus untracked-not-ignored files under the candidate root (outside git, every file except `.git`, `node_modules`, `.venv` and `__pycache__`), and is detect-only above 256 MiB / 20 000 files.
   - Lineage restore covers the whole project root.
   - Processes, services, databases, `.git` internals (interactive) and anything outside the root are not rolled back. Processes started before `submit` keep running during the inspection; their effects are detected afterwards, not prevented. The Verifier is told what its checkpoint covers, and the external-service rule is kept verbatim.
4. **Interactive mode is an extension.** RSIAgent has no interactive mode.
   - The Actor is the user's session with the user's permissions, and may skip `submit`. The Stop hook only nudges or gates.
   - Every terminal interactive verdict may be learned (`kind: "task"`).
   - The authoritative task is the last N captured user-authored messages (text only), not one immutable instruction.
   - The interactive Verifier sees no images or attachments.
5. **Evidence leads are `NOT_RUN`; there is no done-check gate.** RSIAgent validates and executes the Actor's checks (`core/checks.py`) and classifies leads PASS/FAIL. cc-rsi never executes model-authored probes outside a role child, so the gate and the classification are absent.
6. **Handoff by final message.** It replaces handoff files, the `verifier-report` program and `learning_diagnosis.md`. Publication is not atomic with an action. Dry or actionless assistant turns stay in the context: Claude Code cannot drop them, so there is no "semantic replay".
7. **Transport recovery adds a user turn** (a recovery note embedding the original message). RSIAgent retries the unchanged request invisibly. The in-child `CLAUDE_CODE_RETRY_WATCHDOG` keeps 429/529 retries invisible up to its cap.
8. **Compaction.** The target and frozen Actors use Claude Code auto-compaction with a re-pinned verbatim task instead of RSIAgent's fold summarizer. Other roles are lossless, and an overflow is infra. Claude Code's context window is smaller than RSIAgent's ~900k assumptions.
9. **Ceilings.** Iteration ceilings map to per-invocation `--max-turns` plus wall-clock watchdogs; a Claude Code "turn" is not exactly an RSIAgent iteration. Deep budgets default to 6/6 (RSIAgent: unbounded under `curriculum_review`), `waveCeiling` is 16, and `waveConcurrency` is 2 (RSIAgent released 4). The UNVERIFIED counter follows RSIAgent's `dones` reset on tool actions, with an added emergency ceiling (`unverifiedCeiling`, 8). Exhaustion always ends `budget_exhausted`, never as convergence.
10. **Recovery is operator-triggered and generic.** `explore resume` uses pure admission plus the op journal and continues the same sessions with a recovery note. RSIAgent uses incident-specific, operator-authored plans with hash-chain admission. A lost transcript (pruned after `cleanupPeriodDays`) pauses a lineage as `context_lost`.
11. **Practice replay is a copy on the same host.** It is replayed at the Actor's own project root, as in RSIAgent's guest path, but parallel branches share one machine, so Bash could observe siblings: they are hidden only heuristically, or mechanically with a sandbox.
12. **No cross-model asymmetry by default.** Every role inherits the session model unless configured. `doctor` and SessionStart warn when Verifier = Actor (only when both models are known). Escalation and the asymmetric swap work only when `models.escalation` is set.
13. **Exam fence reduced.** It keeps the 8-word shingle tripwire over memory commits, Curriculum handoffs, notes, fixtures and role assistant text. There is no constant-tuple or path rule, no task-id regex, no live egress probe and no evaluator-source quarantine scan.
14. **Phase transitions.** There is no protocol JSON spanning phases and no ACK tokens (replaced by the `--yes` preflight). Ordering is enforced per store: frozen blocks learning lineages; sealed blocks learning until an explicit, recorded `unfreeze --after-sealed`. A Phase-1 `stalled` does not block Phase 2.
15. **Not ported:**
    - the witness gate, visual split ledger and doubt escalation;
    - Look ensembles (Claude Code's Read gives native vision);
    - `FIDELITY_NOTE`;
    - the LIVENESS cycle observation (only REPEAT is ported);
    - unified-loop routers (HANDOFF/VERIFY_MORE, REVISE/EVOLVE; not wired in the released protocol either);
    - the optional Verifier orientation stage.
16. **Memory is per project** (git common dir), not per lineage root. Interactive learning and lineages share one store, serialized by the store lock and conflict-checked by base hash.
17. **Role transcripts** live in `~/.claude/projects/<cwd-slug>/`. Interactive Verifier sessions share the user's project slug and may appear in session pickers. They are hidden from the Actor only by the guard (file tools and a heuristic Bash check), and a changed transcript is detected by its fingerprint before every `--resume`.
18. **POSIX only.** There is no native Windows support. The `bin/` directory makes the plugin ineligible for claude.ai/Cowork distribution, which is not a target.

## Verify-early outcomes

The specification (§17) listed Claude Code behaviours to check on the real binary, each with a fallback. Outcomes recorded by the implementers and the review on Claude Code 2.1.296 in a Linux container without bubblewrap or socat:

| # | Item | Outcome | Consequence |
|---|---|---|---|
| V1 | An `asyncRewake` PostToolUse hook on an MCP tool wakes an idle interactive session | **Not verified** for an idle interactive session. In a review `-p` run the wake was delivered as a task-notification turn labelled as a PostToolUse hook blocking error for `submit`. | Fallback in force: `wait_verdict` is the contract. The rewake hook also fires when the job died, so the Actor's `wait_verdict` triggers recovery. Several pollers of one job wake it once (`<job>.woken`). |
| V2 | A main-session PreToolUse `allow` for a Read outside cwd suppresses the permission prompt in `default` mode | **Not verified** (needs an interactive session). | The guard emits `allow` for the memory view and the open draft. The planned `doctor` hint was not implemented; the README documents the manual allow rule. |
| V3 | `onFailure: "block"` is honoured for `--settings` hooks under `--restricted` | **Verified.** A PreToolUse guard exiting 1 refuses the call with `PreToolUse:Bash hook error: … blocking because onFailure is "block"`, and the call appears in `result.permission_denials` (fixture `test/fixtures/streams/v3-onfailure.jsonl`). | The role guard relies on it for crashes; its own exceptions print a deny. |
| V4 | The role UserPromptSubmit hook fires on `--resume` invocations | **Verified**, before release as required: a digest pass entry appears in the second invocation's guard log (fixture `v4-resume.jsonl`), and the e2e smoke's `cc-rsi doctor --live` reported PASS on the first message and on `--resume`. | Hook attestation stays on UserPromptSubmit. `doctor --live` re-checks it on every run (two messages on one context). |
| V5 | SessionStart(`compact`) from `--settings` fires in `-p` children | **Not verified** (reaching auto-compaction is expensive); covered only against the fake `claude`. | The target/frozen Actor's task re-pin depends on the role `pin` hook. The fallback (inject the pin into the next continuation after a compaction is seen) is not implemented. |
| V6 | The stream-json event name for compaction | **Not observed.** | `stream.mjs` flags any `system` event whose subtype matches `/compact/i`; the flag is informational and steers nothing. |
| V7 | Skill `!` injection with a quoted `"${CLAUDE_PLUGIN_ROOT}"` command matches the quoted `allowed-tools` rule | **Verified** (haiku, `--permission-mode default`): `/cc-rsi:freeze` passed the exact rule `Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze --report-exit)` and froze memory, and `/cc-rsi:explore preflight --phase broad` rendered and Claude explained both blockers. Before `--report-exit`, a non-zero exit aborted the skill (`num_turns` 0). | Skills ship with the quoted form and `--report-exit`. |
| V8 | `_meta["claudecode/toolUseId"]` is present on `tools/call` | **Verified in `-p` mode**: the smoke's real session attested and completed `submit` with real hooks; attestation fails closed otherwise. | Attestation by `tool_use_id` is in force. |
| V9 | The PostToolUse `tool_response` shape for MCP tools | **Indirectly verified** in the same review `-p` run: the rewake hook found `VERIFICATION RUNNING (job …)` in the serialized `submit` response and woke the session. | The rewake hook searches `JSON.stringify(tool_response)` for `VERIFICATION RUNNING (job <id>`; no wake otherwise. |
| V10 | Sandbox `denyWrite: [cwd]` plus `allowWrite: [scratch]` is effective | **Not verifiable here** (no bwrap/socat). The live probe's enforcement branch is tested only against the fake. | `doctor --live` runs the live probe whenever the static probe passes. One quoted `touch` writes a control file inside the allowed directory and a marker outside it: enforced only when the control file exists and the marker does not; a marker means not enforced (WARN); a missing control file means the command never ran (inconclusive, WARN, not recorded). Correctness is unaffected: restore always runs. Sandbox-mode lineages were not run end to end. |
| V11 | `--setting-sources ""` + `--restricted` + `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` hide the project `CLAUDE.md` | **Verified.** A `CLAUDE.md` planted in the cwd was not in context; the model saw its codeword only after reading the file with Read. | No fallback needed. |
| V12 | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` is accepted on 2.1.296 | **Partly verified**: set in real child runs without error; the retry behaviour itself was not exercised. | cc-rsi's own backoff still bounds pauses. |

Further observations on the real binary that shaped the code:

- The exact child argv is accepted, including the empty `--setting-sources ""` element, `--append-system-prompt-file`, `--include-hook-events` and `--tools` last.
- Permission deny rules such as `Read(//hidden/**)` refuse a call **before** any PreToolUse hook runs. Such calls have no guard entry, so guard-gap detection excludes calls listed in `result.permission_denials`.
- `total_cost_usd` is cumulative across `--resume`; replies record a per-message delta.
- `--resume` works from a different cwd.
- With `--include-hook-events`, the UserPromptSubmit `hook_started`/`hook_response` events precede `system/init`.
- The model fills Bash `tool_input.description` differently on otherwise identical calls, so the liveness REPEAT key ignores it.
- `claude plugin validate . --strict` fails on a manifest without `version` ("No version specified"), so `plugin.json` carries a version (see below).
- Review runs (`-p`, haiku) before the fixes showed: a `--model` session left `session.json` without a model while every transcript assistant record carried it; a Stop hook that answered with `additionalContext` while a background task ran was re-run on every stop (18 runs in one session); every nudge as `decision: block` raised a "Stop hook error occurred" notification; with `{"isolation":{"sandbox":"require"}}` in the global file and no saved option, the SessionStart banner said `refused` while the MCP server used `rollback`; a skill whose `!` command exited non-zero ended with `num_turns` 0. Each is fixed as described above and covered by tests.

**End-to-end smoke** (`CC_RSI_E2E=1 node scripts/run-tests.mjs test/e2e`, real `claude` 2.1.296, `--model haiku`, latest run 9 min 34 s): 6 tests, 5 passed, 0 failed, 1 skipped.

1. `cc-rsi doctor --live`: PASS `live-auth`; PASS `live-hooks` on the first message and on `--resume`.
2. `claude -p --plugin-dir <repo>` with real hooks, MCP attestation and `submit`: a verdict record with its isolation, the workspace restored (`git status` shows only the session's own `?? hello.txt`), no workspace lock left and no `--session-id` reused. This run also exercised the SessionStart plugin fingerprint and the `submit`-side check.
3. A broad lineage with `--allow-unconfined --foreground`: terminated `budget_exhausted` or `saturated`, journal commits with tree hashes, `official_evaluator_calls: 0`.
4. SIGTERM mid-wave then resume: skipped (needs `CC_RSI_E2E_FULL=1`); the same path is covered with the fake `claude` in `test/cli/explore.test.mjs`.
5. Freeze, a frozen lineage, then `cc-rsi eval run --json-out`: `scored`, score 1, `frozen_intact: true`, `official_evaluator_feedback_entered_agent: false`, score withheld from the piped stdout.

Offline: `npm test` runs 717 tests in 89 suites, all passing (about 6 minutes); `claude plugin validate . --strict` passes (run with a temporary `HOME` and `CLAUDE_CONFIG_DIR`). Not covered in this environment: Node 18 (the suites ran on Node 20.20 and 22.22; the code avoids post-18 APIs) and any sandbox-mode run.

## Recorded deviations from the specification

Behaviour that intentionally differs from [design/SPEC.md](design/SPEC.md), as implemented:

- **Manifest version.** `plugin.json` has `"version": "0.1.0"` (the specification said none) because `claude plugin validate --strict` requires it. Installs therefore follow the version, which must be bumped on every release. The MCP server reports the same version.
- **Preflight exit code.** `explore start` / `explore preflight` without `--yes` exit 3 when blockers exist (0 only when the start would be accepted).
- **`doctor --live`** sends two messages on one context to re-check V4, and adds the live sandbox probe when the static probe passes (up to three tiny calls). It exits 1 when any check fails and also warns on `paused_infra` lineages.
- **Job liveness.** A job whose pid is gone on this machine is recovered immediately (no 30 s heartbeat wait). A fresh heartbeat means alive; a process start token that differs from the recorded one means dead; when identity cannot be read, a command-line check applies, then a heartbeat older than 10 minutes. "This machine" means the same machine id or the same hostname, so a renamed host still recognises its own records.
- **Lock ordering.** The verification job releases the workspace lock before its final status write, so the Actor never receives a verdict while the lock still denies its next edit. The job result is written before the task transition, so a job that dies after recording a verdict is recovered as `done`.
- **Committed-only memory view.** On tamper, the view shows the last committed history snapshot; the session's inventory is built from the view, so uncommitted memory never reaches the Actor.
- **Main guard tightenings.** `~/.cc-rsi/bin` is exec-only for shell commands; a command that names a locked root is denied even from outside it; an external `memory.dir` store is private like `<home>`; the plugin roots are read/exec-only; once a Verifier session id is known, the transcript directories of the session's candidate roots are denied to file tools and Bash (auto-memory and the session's own files excepted), and searches across `~/.claude/projects` are denied; `cc-rsi explore start|resume` is denied also with options before the subcommand.
- **Hidden roots.** Every role (interactive Verifier and lineage roles alike, one list in `lib/runtime/private.mjs`) also hides `<home>/logs`, `plans`, `todos`, `tasks`, `file-history` and `history.jsonl` under `~/.claude` and `$CLAUDE_CONFIG_DIR`, the user's `<TMPDIR>/claude-<uid>` and `/tmp/claude-<uid>`, and an external `memory.dir` store; the interactive Verifier also hides every `~/.cc-rsi/work` tree and every other Verifier's scratch. Each role child with tools gets its own `TMPDIR`.
- **Captures inside parse ops** (see the op journal section), terminal protocol events before the `final` op, Phase-1 branch records under `priv/<wave>/projects/<id>/`, and the extra override `/commits@n`.
- **Configuration.** An invalid value falls back to the next lower layer instead of the default; tighten-only project values are applied last and cannot be loosened by plugin options or flags. The whole `audit` section is global-only and `audit.shingleWords` is bounded to 3–16; a project value that lowers `interactive.checkpointMaxBytes` or `checkpointMaxFiles` is honoured with a warning. `exploration.unverifiedCeiling` (8) is new.
- **CLI additions.** `--project <dir>` on most commands, `verify cancel --grace`, `explore stop --timeout`, `explore abandon --reason`, `cc-rsi help`, `--report-exit`, `gc --project/--session`; `memory import` commits as kind `external`; `gc` keeps anything referenced by a live job or lock.
- **Sealed evaluation additions.** Every attempt runs on a fresh copy; the evaluator runs in its own process group with a private `TMPDIR`; an interrupt aborts without a record; a candidate with links leaving the tree is `blocked` without running the evaluator; `--json-out` refuses model-visible destinations, compared physically; `evaluation.json` may carry `blocked_reason`.

### Behaviour of the latest review round not yet in the specification

The fixes of the latest review were made in code and tests; the specification sections they touch (§4.3, §5.2, §5.4, §5.5, §6.3, §6.5, §7.1, §7.3, §8.2, §8.3, §9.3, §10.6, §10.10, §10.11, §11.1, §11.2, §11.5, §11.6, §11.7, §11.8, §11.9, §11.11, §12.3, §12.7, §12.9, §12.11, §12.13, §13.1, §13.3–§13.6, §14, §16.9) still describe the earlier behaviour. In summary:

- **Requests** (§11.1, §11.8): capture by UserPromptSubmit `source` and an extended prefix list; the scheduled-prompt ledger fed by the guard (`hooks.json` matcher adds CronCreate, ScheduleWakeup, RemoteTrigger); `source` stored per request.
- **Plugin integrity** (§11.5, §11.7, §11.8, §12.5): SessionStart fingerprint; `submit`/job `plugin_changed`; per-invocation engine check and `plugin_changed` pause; plugin roots read-only for the Actor and every role.
- **Verifier transcripts** (§11.2, §11.5, §11.8): append-only `verifierSessionIds` and `verifierCandidateRoots`; transcript fingerprints; context retirement; guard rules for transcript directories.
- **Workspace and jobs** (§9.3, §11.5, §11.6): `checkpointOpen` sticky locks, `recoveryPending`, cross-session recovery by lock takeover, restore-failed markers, `forceReleaseWorkspace`; `candidate_changed_during_inspection` and `not-current` digests; restores that never replace newcomers; non-git walk limits; process start tokens; machine ids in lock, job and lease records.
- **Locks** (§5.4, §5.5): guarded compare-and-swap takeover, fencing (`lost`, `onLost`, `assertHeld`) for the store, `task.json`, workspace locks, recoveries and the engine (journal fence, status `lock_lost`); zombie-aware liveness. The specification's lease-expiry takeover is kept (a live same-host pid is not judged before the lease expires); the 30 s lease bounds pid reuse on plain lease locks, which carry no start token.
- **Memory** (§6.3, §6.5, §14.2): lock-free `storeIntegrity`; drafts of live owners kept with a missing directory; crash-recoverable `rebaseDraft`; `acceptExternal` refused while frozen and the frozen snapshot restorable; `audit` global-only.
- **MCP and hooks** (§11.9, §11.11): wait budget from the arrival of the call and 3 s store lock waits; `memory_commit` without `confirm` for `abandon`; learn/abandon hints; Stop nudges as `additionalContext`, the background hint once per row, the loop guard for every nudge; one rewake per job; options recorded at SessionStart and applied by the MCP server; the session model from the transcript.
- **Engine** (§4.3, §12.7, §12.9, §12.11, §12.13): practice replay at the Actor's root with `<K>/restore`; verified-candidate capture and `candidate_changed_after_verdict`; crash-safe branch abandon; UNVERIFIED counter reset and `unverifiedCeiling`; `other-verifier` handover for the swapped Verifier (and interactively when a report came from another model); `curriculum_decision` reset per evolution; per-role `TMPDIR` and Actor scratch; the Actor's `../../verify` token; accepted drift refreshes the prompt snapshot.
- **Protocol and prompts** (§7.1, §7.3, §8.2, §8.3, §10.10, §10.11): tolerant token lines with near-miss details and a syntax continuation; tolerant CLAIM/PROBE parsing; a truncated reply with actions resets the actionless counter; checkpoint-coverage sections of the live Verifier mechanics; frozen resume boundary and Actor scratch texts; Phase-2 outcome without MEMORY CHANGES; the context-lost Phase-1 recovery notice; continuity text by allowed verdicts; no Grep/Glob named to the main session; the harness-defect rule for refusals inside a role's own directories.
- **CLI** (§13.1, §13.3–§13.6, §5.2): saved plugin options in the CLI; `--report-exit`; terminal command lines in refusals; the `shim` doctor check and real paths in remedies; `verify cancel` identity checks; `explore stop` and `doctor --release-lock` with machine ids and holder liveness; `gc` for sessions without SessionEnd, per-path failures and `--project/--session`; sealed link blocking, evaluator `TMPDIR` and physical `--json-out` checks.
