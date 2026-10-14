# cc-rsi architecture

This document explains how cc-rsi is built: the decisions behind it, its process model and trust boundaries, its state machines and invariants, a map of the modules, the remaining differences from RSIAgent, and what the implementers observed on the real Claude Code binary. The normative interfaces are in [design/SPEC.md](design/SPEC.md); where the implementation deliberately departs from the specification, the departure is listed in [Recorded deviations from the specification](#recorded-deviations-from-the-specification). For installation and use, see the [README](../README.md).

Vocabulary: the **Actor** does the work (the user's main session in interactive mode, a headless child in lineages); the **Verifier** inspects the result and returns a verdict; the **Curriculum** authors practice projects and decides when to retry the target; the **summarizer** writes work logs for resumes. A **role child** is one `claude -p` process sending one role message. **Infra** means an infrastructure outcome (transport, auth, crash, timeout, …), which is never a verdict.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Interactive Verifier | A headless `claude -p` child run by a detached **verification job** that the `submit` MCP tool starts. One Verifier session per task: the first inspection uses `--session-id`, later ones `--resume`, so the same Verifier follows FAIL → repair → re-verify across turns and Claude Code restarts. The job checkpoints the candidate, holds a project-wide workspace lock, restores the candidate (moving displaced files aside, never deleting them) and owns the verdict. `submit` and `wait_verdict` block for at most 110 s; an async PostToolUse hook tries to wake the session when the verdict lands. No plugin subagent ships. |
| 2 | Exploration lineages | A detached Node engine per lineage. One `claude -p` per role message, `--session-id` first and `--resume` after. Every side effect is a memoized op in a journal, so resuming after a crash, stop or infra pause runs the same code path as normal progress. RSIAgent semantics are kept: wave barrier with serial consolidation in authored order, unscored branch restart from immutable fixtures, mandatory fresh target retry after practice, STALLED buys one final test, escalation with an asymmetric Verifier swap, Phase-3 FAIL → same-Actor repair, and infra as a separate outcome class that pauses instead of failing. |
| 3 | Continuation and handoff | A segment is one `claude -p` invocation; `actions` is the number of top-level `tool_use` blocks. The reply is the **final assistant message**, never `result.result`. Three consecutive actionless segments without a valid handoff (or 24 segments) are transport infra. A `max_tokens` stop gets a truncation continuation and is not counted. Handoff tokens are unique standalone lines outside code: `VERDICT:`, `STATUS: SUBMIT`, `DECISION:`. Phase-1 waves use a fenced JSON envelope. |
| 4 | Isolation | Every child runs with `--restricted --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --permission-mode dontAsk --tools <explicit>` and a per-invocation `--settings` file: permission rules and `additionalDirectories`, a fail-closed role guard that never emits `allow`, a UserPromptSubmit digest filter that also proves the hooks ran, a sandbox block only in sandbox mode (`failIfUnavailable: true`), and forwarded auth/provider keys. The environment is allowlisted. Without an OS sandbox the interactive Verifier degrades explicitly to `rollback`; lineages refuse unless `--allow-unconfined`. |
| 5 | Memory store | `~/.cc-rsi/projects/<key>/store` (not `CLAUDE_PLUGIN_DATA`, which is wiped on uninstall). The dsh-rsi store with additions: external draft directories, two-step commit with a pending marker, journal, history snapshots, lease lock, freeze with hash check, sealed marker, 8-word shingle quarantine, UTF-8-ordered `tree_sha256` byte-compatible with RSIAgent, canonical tamper detection, conflict rebase. The main Actor reads a read-only materialized view, never the canonical tree. |
| 6 | Tool surface | MCP server `rsi` with five tools: `submit`, `wait_verdict`, `learn`, `memory_commit`, `status`. Calls are bound to the calling session by PreToolUse attestation keyed by `tool_use_id`, matched against `params._meta["claudecode/toolUseId"]`. Role children get no MCP; their memory is a directory. |
| 7 | Hooks | One dispatcher `hooks/hook.mjs`: SessionStart (protocol, memory inventory, notices, shim), UserPromptSubmit (verbatim request capture, task bookkeeping, S0 baseline), PreToolUse (private-path and lock guard; MCP attestation), PostToolUse (async rewake), Stop (nudge/gate), PostModelSwitch (model tracking), SessionEnd (mark ended). Main-session hooks fail open. Role-child hooks (`hooks/role-guard.mjs`) are installed only through `--settings` and fail closed. |
| 8 | Entry points | Skills `/cc-rsi:status`, `/cc-rsi:explore`, `/cc-rsi:memory`, `/cc-rsi:freeze`, `/cc-rsi:doctor`. No commands, agents or workflows; no unfreeze or eval skill. `bin/cc-rsi` is the CLI. Sealed evaluation runs from a terminal only and prints the score only to a TTY. Human-only subcommands refuse under `CLAUDECODE`, and the main guard denies them to model Bash. |
| 9 | Prompts | `prompts/*.md` templates with `{{NAME}}` placeholders, rendered by `lib/prompts`. The texts are RSIAgent's, as dsh-rsi neutralised them. RSIAgent's JSON action protocol is replaced by native tools; publication is the final message. Each lineage snapshots its templates. |
| 10 | Configuration | Three `userConfig` keys (`verifier_model`, `stop_policy`, `sandbox`). JSON config in `~/.cc-rsi/config.json` (global) and `<project>/.claude/cc-rsi.json` (project). Security keys are global-only; isolation keys may only be tightened by the project file. Defaults live in `lib/core/config.mjs`. |
| 11 | Testing | `node:test` units per module; a fake `claude` that emulates stream-json, session semantics, crashes, hangs and executes `--settings` hooks; a crash matrix over the op journal; hook tests with synthetic stdin; MCP protocol tests; `claude plugin validate . --strict`; an opt-in real `--model haiku` smoke. |
| 12 | Honesty | Every remaining difference from RSIAgent is listed below. Every verdict and lineage record states the isolation actually used. |

### Claude Code behaviour the decisions rely on

- `--session-id` is honoured and `--resume` keeps the context and the id. A child started without `--session-id` inherits the outer session id and appends to the outer transcript, so every context mints a fresh uuid and an id is never reused (reuse fails with "already in use").
- `--restricted` keeps OAuth working and confines file tools to the working directories, but ignores user settings files; auth and provider keys are therefore forwarded explicitly.
- `--setting-sources ""` drops project settings, `.mcp.json` and `CLAUDE.md`; settings-file hooks still fire under `--restricted`.
- A PreToolUse `allow` overrides `dontAsk`, so role hooks never emit `allow`. Permission deny rules are applied before PreToolUse hooks.
- `--tools`, `--add-dir` and `--allowedTools` are variadic, so the prompt always goes on stdin and directories and rules go into the settings file.
- Main-conversation MCP calls move to the background after about 120 s; waits are therefore bounded at 110 s and lowered further under `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`.
- `CLAUDECODE=1` is set in every Claude Code subprocess, including skill `!` injection and the Bash tool; the CLI uses it to refuse human-only actions.
- Plugin agents ignore `permissionMode`, `hooks` and `mcpServers` and inherit the session's permission mode, so a subagent Verifier would surface its Bash prompts in, and widen, the main session. That is why the Verifier is a headless child.

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
        --max-turns N --tools <explicit>        stdin = the message      env = allowlist + CC_RSI_ROLE …
        hooks (via --settings): hooks/role-guard.mjs prompt | tool | post | pin
```

- The main session never runs a Verifier inline. Role children are spawned only by verification jobs, lineage engines and `cc-rsi doctor --live` (plus the one-call auth probe at lineage start).
- Jobs and engines are detached process-group leaders with stdio redirected to log files. They outlive the MCP server and the session, write their own state atomically, and clean up their own checkpoints. Children share the leader's process group. Shutdown sends SIGINT, waits, SIGTERM, waits, then SIGKILL.
- `lib/runtime/child.mjs` is the only module that spawns `claude` (enforced by `test/plugin/boundaries.test.mjs`). Hooks never spawn `claude`; they start job recovery and the S0 baseline only as detached processes by file path.
- Recursion is closed: the CLI, engine and job refuse when `CC_RSI_ROLE` is set; the role guard denies `claude`, `cc-rsi` and `npx @anthropic-ai/claude-code`; children's `PATH` excludes the cc-rsi bin directories.

## Trust boundaries

Each boundary is enforced by the modules in brackets.

1. **Roles hear only the harness.** Child stdin is owned by the job or engine. A role child's UserPromptSubmit hook blocks any prompt whose sha256 differs from `CC_RSI_EXPECT`, and a passing entry in the guard log is mandatory: a child whose hooks did not run is infra `hooks_not_run`. [`hooks/role-guard.mjs prompt`, `lib/runtime/stream.mjs`, `lib/runtime/classify.mjs`]
2. **Verdicts are harness-owned.** The Verifier's final assistant message is parsed by the job or engine. Verdict state is written only by the job (interactive) or the engine (lineages), under `~/.cc-rsi`. Everything under `~/.cc-rsi` except the read-only view, the shim and the open learning draft is denied to the Actor's file tools and Bash path tokens. Reports are content-addressed and re-hashed on read. [`lib/runtime/stream.mjs`, `lib/protocol/tokens.mjs`, `lib/hooks/guard.mjs`, `MemoryStore.getReport`]
3. **The Verifier is blind to the Actor's narrative.** It receives the user's messages (interactive) or the task text (lineages), mechanical change facts computed by the harness, its own prior reports, and evidence leads only as formatted `LEAD` blocks. `verifierCharter` throws on anything else. Leads are never executed by the harness. [`lib/prompts/roles.mjs`, `lib/protocol/leads.mjs`]
4. **Infra is a separate outcome class.** Every invocation is classified before any parse. Infra never becomes PASS or FAIL, never enables `learn`, and never commits memory. [`lib/runtime/classify.mjs`, the job and engine code paths]
5. **Sealed evaluation runs outside every model context.** CLI-only; refuses under `CLAUDECODE` or `CC_RSI_ROLE`; prints the score only to a TTY; keeps records under hidden `~/.cc-rsi` paths; `--json-out` refuses model-visible destinations. [`lib/sealed/eval.mjs`, `lib/cli/eval.mjs`, `lib/hooks/guard.mjs`]
6. **Memory changes only through commits.** Canonical memory is never exposed writable. The tree hash is compared with the last journal `treeAfter` at every sensitive step (SessionStart warns; `learn`, `memory_commit`, commits, lineage starts, resume admission, waves, target and practice steps refuse or pause). The Actor's view always shows committed memory: on tamper the view is materialized from the last committed history snapshot. [`MemoryStore.assertCanonicalIntact`, `lib/interactive/memview.mjs`]
7. **Human-only operations need a human.** Unfreeze, restore, accept-external, import, draft pruning, abandon, lock release, verification cancel and sealed evaluation refuse under `CLAUDECODE` (exit 65), and the main guard denies them to model Bash. Lineage start and resume are denied to model Bash unless the global `exploration.modelMayStart` is set. [`lib/cli/main.mjs`, `lib/hooks/guard.mjs`]

## State machines

### Interactive task (`task.json`, `lib/interactive/task.mjs`)

`task.json` is changed under the session lease lock, which hooks hold for at most 5 s. A task carries the Verifier context (`ctxKey`, session id, model, `retired`), a generation counter, its reports, the last verdict and whether it was learned. An unlearned terminal task is kept as `prevTask` when a new one opens, so it can still be learned.

| Event | Guard | Effect |
|---|---|---|
| UserPromptSubmit | not synthetic (task notifications, slash commands, …); no learning phase; no job; and no task, a closed task or a `PASS` task | `openTask`: `taskSeq++`, record the status digest and spawn the S0 baseline; an unlearned PASS/FAIL task becomes `prevTask` |
| `submit` | a job is running | behaves like `wait_verdict` |
| `submit` | a learning phase is open | refused (`learning_open`) |
| `submit` | no task, a closed task, a different candidate root, or a `PASS` task with a newer request | `openTask` first (covers sessions whose prompt hook did not run) |
| `submit` | an undelivered verdict of the current generation still covers the workspace | delivered instead of a redundant inspection |
| `submit` (accepted) | — | set the candidate root, `generation++`, pick the Verifier context (reuse it unless retired, the model changed or idle > `verifierIdleHours`; otherwise a fresh context seeded with prior reports), write the job file, spawn the job |
| job result: verdict | the job's task is `task` or `prevTask` | push the report; set `lastVerdict`; `learned = false`; record the Verifier session; clear the job |
| job result: infra | — | clear the job; no verdict; retire the Verifier context on `context_overflow` or a lost established transcript |
| `learn` | a terminal, unlearned, current (status digest unchanged) verdict; `mode: learn`; memory not frozen, sealed or tampered | open a draft at `drafts/<episode>`; `learning = {stage: distill, code}` (a repeated `learn` re-issues the current stage) |
| `memory_commit` | `confirm` equals the current code | `distill` → `reconcile` (new code); `reconcile` → commit: promoted marks the task learned and closed; `limit` → condense with a new code; `conflict` → rebase the draft, new code; quarantine is neutral |
| `memory_commit({abandon: true})` | `confirm` equals the current code | discard the draft; the task counts as handled |

Each stage message carries a fresh 6-hex confirmation code, so the Actor can only advance after reading the stage instructions; no transcript parsing is needed.

### Verification job (`lib/interactive/verify-job.mjs`)

```
queued ──spawn──▶ running ──▶ done   (result: verdict, report sha, restored/displaced paths, isolation, model, digests)
                     │
                     └──────▶ infra  ({cls, detail}: workspace_busy, checkpoint_failed, sandbox_required, auth, config,
                                       transient_exhausted, restore_failed, cancelled, job_died, …)
```

1. Write `running`, start a 5 s heartbeat.
2. Take the project-wide workspace lock for the candidate root (held by another live job → `workspace_busy`).
3. Record the status digest, then take the checkpoint (git-listed plus untracked-not-ignored files; detect-only above the size caps).
4. Build the mechanical context: workspace facts, the S0 baseline delta, and `CHANGED SINCE YOUR LAST INSPECTION`.
5. Decide isolation (`sandbox`, `rollback`, or refuse under `require`).
6. Send the charter on the task's Verifier context (`--session-id` or `--resume`), continue in the same context until a valid `VERDICT:` line.
7. Always restore the checkpoint, also after infra, moving displaced versions aside. A failed restore keeps the lock with `restoreFailed: true` (fail closed); only `cc-rsi doctor --release-lock` (human-only) releases it.
8. Store the report, write the job result, apply the task transition, append `verdicts.jsonl`, release the lock, then write the final status.

**Recovery.** SessionStart, `submit`, `wait_verdict` and `status` spawn `verify-job.mjs recover` for any job whose process is gone: it restores an open checkpoint, records infra `job_died` ("this is not a verdict"), clears the task's job and releases the lock unless the restore failed. Recovery never runs while the job's pid is alive. A job that recorded its verdict before dying is finished as `done`.

### Lineage status (`state.json`, `lib/engine/daemon.mjs`)

```
starting ──▶ running ──┬──▶ completed     (result.json written in the final op)
                       ├──▶ quarantined   (audit hit; absorbing)
                       ├──▶ paused_user   (SIGTERM / explore stop)        ──explore resume──▶ running
                       └──▶ paused_infra  (InfraError: cls + pausedAt op)  ──explore resume──▶ running
any non-terminal status, engine not live ──explore abandon──▶ abandoned  (result.json termination "abandoned")
```

The daemon exits 0 when it completes, pauses or quarantines, 3 when another engine holds the lineage's lease, 64 inside a role context and 1 on an unexpected error. A lineage marked `running` whose engine died is continued with `explore resume`; the stale lease is taken over.

`explore resume` runs a write-free admission (`admitResume`), then `applyResume` grants overrides for the paused op when it ends in `/liveness@n` (one stall continuation), `/unverified@n` (one more practice evidence round) or `/commits@n` (four more commit attempts). Any other pause re-runs the pending op in recovering mode: the same session plus a recovery note that embeds the original message.

### Op journal and determinism (`lib/engine/journal.mjs`)

Every side effect of a lineage is an op `j.op(key, kind, args, fn)` recorded in `ops.jsonl` (fsync per line; large results in `blobs/`):

- a `done` record replays its recorded result (a different `kind` or `argsSha` throws `ReplayDivergence`);
- a `start` without `done` re-runs `fn` in recovering mode;
- otherwise `start`, run, `done`.

Determinism rules: every role send, filesystem write, store mutation and protocol event is inside an op, and so is every filesystem or store observation that steers control flow (shape gates, authoring listings, wave and decision validation, manifest and fingerprint comparisons, tamper checks, audit results, commit outcomes). Uuids are generated only inside ops; configuration, models, prompts and isolation come from `lineage.json` and the prompt snapshot; counters are recomputed from recorded results.

Concretely:

- each fixture capture happens inside the same recorded op that validates the Curriculum's handoff, so a recorded valid handoff always has its immutable captures, even if the authoring tree is deleted before a resume;
- each protocol event is idempotent by op key, and terminal events are written just before the `final` op;
- each role message is a memoized `send` op: a recovering send re-sends the message inside a recovery note in the same session, and a session that never started is restarted with a new uuid (never reusing the old id).

The crash matrix (`test/engine/crash-matrix.test.mjs`) throws or SIGKILLs at every op of reference broad and deep runs, including SIGKILL in the middle of a role message and workspace mutation before resume, and checks that `result.json`, the memory tree hash and the committed episode list equal the uninterrupted run.

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
      then a fresh Verifier on a replay of the captured candidate (exactly one inspection, no UNVERIFIED)
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
  Curriculum loop (one Curriculum context for the lineage):
    practice or cost budget reached → budget_exhausted if no practice this evolution, else one final target attempt
    decision: PROJECT (body contains <PROJECT_ROOT>, practice/authoring passes the shape gate → captured)
              → practice project (Verifier may answer UNVERIFIED; evidence rounds) → same Actor learns, with diagnosis
            | READY_FOR_TARGET → break | STALLED → finalAfterStall, break
  PASS with no practice this evolution → verifier_pass_curriculum_ready | verifier_pass_curriculum_stalled
  otherwise → MANDATORY fresh target attempt
```

**Target attempt** (shared by deep and frozen):

```
Actor work → STATUS: SUBMIT + shape gate → protected live inspection (checkpoint, Actor memory removed, restore if changed)
  PASS → terminal
  FAIL → terminal (deep) | same-Actor repair, same Verifier (frozen; ≥ frozenRepairRounds → stall)
  UNVERIFIED → evidence leads from the same Actor (≥ unverifiedRounds → stall)
stall (Actor liveness or round limit) → one forced inspection
  PASS, or FAIL in deep → terminal, learned by the same held Actor
  otherwise, while resumes < targetResumes: synthesize a work log (summarizer, or a digest fallback),
      strategy review when the root did not change, resume in a FRESH Actor context
      with escalation: Actor model := escalation; if escalation equals the Verifier model, the Verifier is swapped
      once to the original Actor model with no history and no prior reports
  else → UNVERIFIED (or FAIL in frozen), not learnable
terminal (deep): distill → reconcile → diagnosis → commit (≤ 4 attempts; limit → condense, conflict → rebase)
```

A Verifier FAIL never triggers a fresh-context pivot; only stalls do. Verifier transport infra is not a stall: the lineage pauses.

### Phase 3: frozen lineage (`lib/engine/frozen.mjs`)

Requires a frozen, intact store. One target attempt with `frozen: true` (FAIL → same-Actor repair; no learning; no Curriculum). The final op re-asserts the frozen tree (mismatch → infra `memory_frozen_tamper`), captures the final candidate and writes `result.json` with `frozen_tree_sha256` and `official_evaluator_calls: 0`. Sealed evaluation is a separate, terminal-only step.

### Sealed evaluation (`lib/sealed/eval.mjs`)

Refuse (inside Claude Code; no evaluator; lineage not a finished deep/frozen lineage; live engine; candidate changed) → freeze if needed and assert frozen-intact → copy the final candidate per attempt → run the evaluator with retries and the identical-error limit → re-assert frozen-intact → mark the store sealed → write `evaluation.json` and the lineage's `sealed.json` (no score) → print the score only to a TTY. While the store is sealed, learning refuses until `cc-rsi memory unfreeze --after-sealed`.

## Invariants

- **Infra ≠ verdict.** An infrastructure outcome never becomes PASS or FAIL, never opens learning, never commits memory, and is never terminal for a lineage (it pauses).
- **Readiness ≠ correctness.** `READY_FOR_TARGET` is recorded as `curriculum_decision`, never as a verdict. Any practice forces a fresh, unchanged-target attempt; `STALLED` buys exactly one final target test; exhausted budgets end `budget_exhausted`, never as convergence.
- **UNVERIFIED is never learned.** Only PASS and FAIL are terminal for learning.
- **Learning is serial and on the latest memory.** Wave consolidation runs in authored order after the barrier; every commit checks the draft's base hash and rebases on conflict; an episode is never committed twice (idempotent by episode and origin).
- **Memory changes only through commits**, and only through the store: limits, audit, conflict check, atomic install with a pending marker, journal record with tree hashes before and after, history snapshot.
- **Sealed isolation.** No model context sees an evaluation score; the evaluator runs on a copy; frozen memory is verified before and after; a sealed store closes learning until a recorded human override.
- **The workspace is restored.** Every interactive inspection restores its checkpoint (also after infra), never deletes a pre-existing or ignored file, and keeps displaced versions; a failed restore keeps the workspace locked.
- **Session ids are never reused.** Every context mints a fresh uuid; `--resume` is used only for a session this context created.
- **The role guard never emits `allow`** and fails closed on any error; a child whose hooks did not run is infra.
- **Every record states its isolation** (`sandbox` | `rollback` for interactive verdicts, `sandbox` | `unconfined` for lineages), and the Verifier's mechanics text is rendered from the actual mode.

## Module map

Entry points:

| Path | Role |
|---|---|
| `bin/cc-rsi` | CommonJS shim: Node ≥ 18 and role-context checks, then dynamic import of `lib/cli/main.mjs` |
| `hooks/hooks.json` | Main-session hook registrations |
| `hooks/hook.mjs` | Main-session hook dispatcher → `lib/hooks/<sub>.mjs` |
| `hooks/role-guard.mjs` | Role-child hook (`prompt`, `tool`, `post`, `pin`), installed only via `--settings`; imports only `lib/core` and `lib/guard` |
| `mcp/server.mjs` | MCP server entry → `lib/mcp/server.mjs` |
| `.mcp.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin manifests |
| `skills/{status,explore,memory,freeze,doctor}/SKILL.md` | Skills; each runs `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" …` via `!` injection |
| `prompts/*.md` | Role, charter, continuation, learning and guidance templates |
| `scripts/run-tests.mjs` | Test runner (explicit file list; `test/e2e` only with `CC_RSI_E2E=1`) |

`lib/core` (shared primitives; imports only `node:*` and siblings):

- `lib/core/paths.mjs` — home, global/project/session/lineage layouts, project key, safe names.
- `lib/core/config.mjs` — defaults, layered loading, global-only and tighten-only rules, validation, userConfig mapping.
- `lib/core/atomic.mjs` — atomic file writes and JSON reads, directory fsync, `ensureDir`, `rmrf`.
- `lib/core/jsonl.mjs` — fsync'd JSONL appends that tolerate a torn tail.
- `lib/core/lock.mjs` — cross-process lease lock (dsh store lock) and `withLock`.
- `lib/core/ids.mjs` — uuids, job/lineage/episode/run ids, confirmation codes, validators.
- `lib/core/digest.mjs` — sha256 helpers and canonical JSON with UTF-8 key order.
- `lib/core/proc.mjs` — `pidAlive`, `spawnDetached`, `killGracefully`, `runCapture`.
- `lib/core/log.mjs` — file logger (JSONL, never stdout, never throws).
- `lib/core/errors.mjs` — `CcRsiError`, `UsageError`, `LockTimeoutError`, `HumanOnlyError`, `RoleContextError`.

`lib/memory` (the store):

- `lib/memory/hash.mjs` — `canonicalJson`, `treeSha256`, `manifestSha256`; byte-compatible with RSIAgent.
- `lib/memory/safe-path.mjs` — safe relative memory paths.
- `lib/memory/tree.mjs` — scan, pull and write memory trees (regular files only; symlink, special-file and non-UTF-8 rejection).
- `lib/memory/errors.mjs` — the `MemoryError` family with stable codes.
- `lib/memory/store.mjs` — `MemoryStore`: drafts, two-step commit, recovery, tamper detection, freeze, sealed marker, history, reports.
- `lib/memory/audit.mjs` — 8-word shingle leakage tripwire.
- `lib/memory/inventory.mjs` — inventory listing (names and sizes only).
- `lib/memory/view.mjs` — read-only views and writable copies of a memory tree.

`lib/protocol` (handoff parsing):

- `lib/protocol/tokens.mjs` — prose view and unique standalone `VERDICT:` / `STATUS: SUBMIT` / `DECISION:` tokens.
- `lib/protocol/wave.mjs` — Phase-1 wave JSON envelope.
- `lib/protocol/leads.mjs` — CLAIM/PROBE parsing, MCP lead validation, `LEAD` block rendering.

`lib/prompts` (texts):

- `lib/prompts/render.mjs` — template loading (plugin or lineage snapshot), strict `{{NAME}}` rendering, sections, snapshots.
- `lib/prompts/roles.mjs` — role prompt builders (systems, charters, continuations, learning stages, Curriculum and summarizer texts).
- `lib/prompts/guidance.mjs` — interactive MCP result texts (verdict, running, infra, refusals, commit results).

`lib/workspace` (files and git, never running repository-planted programs):

- `lib/workspace/copy.mjs` — tree copy (no `fs.cp`), removal, move-aside, write-bit helpers.
- `lib/workspace/git.mjs` — hardened git, project root via the git common dir, workspace facts, status digest, inert repo.
- `lib/workspace/checkpoint.mjs` — interactive checkpoint with displaced-copy restore, persisted for cross-process recovery.
- `lib/workspace/fingerprint.mjs` — tree fingerprints, project manifests, change descriptions.
- `lib/workspace/fixtures.mjs` — shape gate, capture, replay, verify and read-only views of fixture and candidate trees.
- `lib/workspace/baseline.mjs` — S0 baseline at task open and its delta; detached CLI entry.

`lib/guard` (heuristic guards shared by the role guard and the main guard):

- `lib/guard/paths.mjs` — physical path resolution, file-tool path extraction, search-root coverage.
- `lib/guard/bash.mjs` — Bash command scanning: hidden paths and tokens, recursion, mutation deny patterns.

`lib/runtime` (headless role children):

- `lib/runtime/errors.mjs` — `InfraError`, `TransportInfraError`, `InterruptedError`, retryable classes.
- `lib/runtime/claude-bin.mjs` — resolve the `claude` binary, its version and required flags.
- `lib/runtime/env.mjs` — child environment allowlist and never-pass list.
- `lib/runtime/auth-settings.mjs` — forwarded user-scope auth and provider settings.
- `lib/runtime/models.mjs` — model resolution chain and `effective()`.
- `lib/runtime/policy.mjs` — role policy JSON for the role guard.
- `lib/runtime/settings.mjs` — per-invocation `--settings` (permissions, hooks, sandbox, forwarded keys).
- `lib/runtime/argv.mjs` — the exact child command line.
- `lib/runtime/stream.mjs` — stream-json parsing and hook attestation.
- `lib/runtime/classify.mjs` — outcome classification table (first match wins).
- `lib/runtime/child.mjs` — spawn one invocation with watchdog and logs; the only module that starts `claude`.
- `lib/runtime/context.mjs` — `RoleContext`: one persistent session per role identity, transient retry, recovery note, sandbox degrade.
- `lib/runtime/converse.mjs` — same-context continuation loop with liveness and ceiling.
- `lib/runtime/sandbox.mjs` — static and live sandbox probes, isolation decision.

`lib/interactive` (everyday mode state):

- `lib/interactive/session.mjs` — session context, `session.json`, project resolution and caching.
- `lib/interactive/requests.mjs` — verbatim request capture and the Verifier's task messages.
- `lib/interactive/task.mjs` — task state machine and job-file helpers (liveness, recovery spawn).
- `lib/interactive/attest.mjs` — write, take and sweep MCP attestations.
- `lib/interactive/wslock.mjs` — project-wide workspace locks (sticky after a failed restore).
- `lib/interactive/verify-job.mjs` — the detached verification job (`run` and `recover`).
- `lib/interactive/memview.mjs` — refresh of the main session's read-only memory view.

`lib/mcp` (server `rsi`):

- `lib/mcp/jsonrpc.mjs` — newline-delimited JSON-RPC 2.0 over stdio.
- `lib/mcp/server.mjs` — MCP protocol handling, progress and cancellation.
- `lib/mcp/tools.mjs` — the five tools, argument validation, bounded waits, status text.

`lib/hooks` (main-session hooks; fail open):

- `lib/hooks/common.mjs` — stdin parsing, output helpers, role no-op, fail-open wrapper.
- `lib/hooks/session-start.mjs` — record the session, refresh the shim and view, recover dead jobs, inject protocol and memory context.
- `lib/hooks/prompt.mjs` — synthetic-prompt filter, request capture, task opening, baseline spawn.
- `lib/hooks/guard.mjs` — private-path and workspace-lock guard, human-only Bash denial.
- `lib/hooks/attest.mjs` — MCP call attestation.
- `lib/hooks/rewake.mjs` — async rewake when a verdict lands.
- `lib/hooks/stop.mjs` — stop policy (`off` | `nudge` | `gate`).
- `lib/hooks/model.mjs` — track model switches in `session.json`.
- `lib/hooks/session-end.mjs` — mark the session ended.

`lib/engine` (exploration lineages):

- `lib/engine/journal.mjs` — memoized op journal with overrides and blobs.
- `lib/engine/records.mjs` — preflight, creation, `lineage.json`/`state.json`/events/results, resume admission, abandon, show.
- `lib/engine/roles.mjs` — per-role specs, hidden roots and the journaled `EngineContext`.
- `lib/engine/steps.mjs` — journaled converse wrapper and free (learning) phases.
- `lib/engine/inspect.mjs` — protected practice (replay) and target (live) inspections.
- `lib/engine/learn.mjs` — same-Actor learning: distill, reconcile, diagnosis, commit loop.
- `lib/engine/project.mjs` — practice projects with unscored restart.
- `lib/engine/target.mjs` — target attempt: stall, forced inspection, resume, escalation swap.
- `lib/engine/worklog.mjs` — work log synthesis and strategy review.
- `lib/engine/broad.mjs` — Phase 1 waves.
- `lib/engine/deep.mjs` — Phase 2 target/practice loop.
- `lib/engine/frozen.mjs` — Phase 3 frozen lineage.
- `lib/engine/daemon.mjs` — detached entry: lease, signals, phase dispatch, pause and finish.

`lib/sealed` and `lib/cli`:

- `lib/sealed/eval.mjs` — sealed evaluation.
- `lib/cli/main.mjs` — argument parsing, dispatch, role and human-only refusals, `version`, `engine run`, `verify cancel`.
- `lib/cli/status.mjs` — `cc-rsi status`.
- `lib/cli/doctor.mjs` — `cc-rsi doctor` checks, `--live` probes, `--release-lock`.
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
   - RSIAgent uses QEMU rollback, namespaces and a private tmpfs scratch.
   - The sandbox, when present, wraps Bash only. Hooks, MCP and Claude Code itself run unsandboxed.
   - Every record states the mode actually used. Lineages require an explicit `--allow-unconfined` without a sandbox.
2. **Same OS user.** The Actor (the user's session) and every role share one uid. Forgery or reading by obfuscated Bash is possible. The guards stop accidents and casual access; tamper detection and report re-hashing **detect** canonical-memory and report changes. Neither prevents a determined adversary.
3. **Rollback scope.**
   - Interactive restore covers git-listed plus untracked-not-ignored files under the candidate root, and is detect-only above 256 MiB / 20 000 files.
   - Lineage restore covers the whole project root.
   - Processes, services, databases, `.git` internals (interactive) and anything outside the root are not rolled back. The Verifier is told so, and the external-service rule is kept verbatim.
4. **Interactive mode is an extension.** RSIAgent has no interactive mode.
   - The Actor is the user's session with the user's permissions, and may skip `submit`. The Stop hook only nudges or gates.
   - Every terminal interactive verdict may be learned (`kind: "task"`).
   - The authoritative task is the last N captured user messages (text only), not one immutable instruction.
   - The interactive Verifier sees no images or attachments.
5. **Evidence leads are `NOT_RUN`; there is no done-check gate.** RSIAgent validates and executes the Actor's checks (`core/checks.py`) and classifies leads PASS/FAIL. cc-rsi never executes model-authored probes outside a role child, so the gate and the classification are absent.
6. **Handoff by final message.** It replaces handoff files, the `verifier-report` program and `learning_diagnosis.md`. Publication is not atomic with an action. Dry or actionless assistant turns stay in the context: Claude Code cannot drop them, so there is no "semantic replay".
7. **Transport recovery adds a user turn** (a recovery note embedding the original message). RSIAgent retries the unchanged request invisibly. The in-child `CLAUDE_CODE_RETRY_WATCHDOG` keeps 429/529 retries invisible up to its cap.
8. **Compaction.** The target and frozen Actors use Claude Code auto-compaction with a re-pinned verbatim task instead of RSIAgent's fold summarizer. Other roles are lossless, and an overflow is infra. Claude Code's context window is smaller than RSIAgent's ~900k assumptions.
9. **Ceilings.** Iteration ceilings map to per-invocation `--max-turns` plus wall-clock watchdogs; a Claude Code "turn" is not exactly an RSIAgent iteration. Deep budgets default to 6/6 (RSIAgent: unbounded under `curriculum_review`), `waveCeiling` is 16, and `waveConcurrency` is 2 (RSIAgent released 4). Exhaustion always ends `budget_exhausted`, never as convergence.
10. **Recovery is operator-triggered and generic.** `explore resume` uses pure admission plus the op journal and continues the same sessions with a recovery note. RSIAgent uses incident-specific, operator-authored plans with hash-chain admission. A lost transcript (pruned after `cleanupPeriodDays`) pauses a lineage as `context_lost`.
11. **Practice replay is a copy on the same host.** Parallel branches share one machine, so Bash could observe siblings: they are hidden only heuristically, or mechanically with a sandbox.
12. **No cross-model asymmetry by default.** Every role inherits the session model unless configured. `doctor` and SessionStart warn when Verifier = Actor. Escalation and the asymmetric swap work only when `models.escalation` is set.
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
17. **Role transcripts** live in `~/.claude/projects/<cwd-slug>/`. Interactive Verifier sessions share the user's project slug and may appear in session pickers. They are hidden from the Actor only by the guard.
18. **POSIX only.** There is no native Windows support. The `bin/` directory makes the plugin ineligible for claude.ai/Cowork distribution, which is not a target.

## Verify-early outcomes

The specification (§17) listed Claude Code behaviours to check on the real binary, each with a fallback. Outcomes recorded by the implementers on Claude Code 2.1.296 in a Linux container without bubblewrap or socat:

| # | Item | Outcome | Consequence |
|---|---|---|---|
| V1 | An `asyncRewake` PostToolUse hook on an MCP tool wakes an idle interactive session | **Not verified.** It needs an idle interactive session, which the offline suites and the `-p` smoke cannot drive. | Fallback in force: `wait_verdict` is the contract. The rewake hook also fires when the job died, so the Actor's `wait_verdict` triggers recovery. |
| V2 | A main-session PreToolUse `allow` for a Read outside cwd suppresses the permission prompt in `default` mode | **Not verified** (needs an interactive session). | The guard emits `allow` for the memory view and the open draft. The planned `doctor` hint was not implemented; the README documents the manual allow rule. |
| V3 | `onFailure: "block"` is honoured for `--settings` hooks under `--restricted` | **Verified.** A PreToolUse guard exiting 1 refuses the call with `PreToolUse:Bash hook error: … blocking because onFailure is "block"`, and the call appears in `result.permission_denials` (fixture `test/fixtures/streams/v3-onfailure.jsonl`). | The role guard relies on it for crashes; its own exceptions print a deny. |
| V4 | The role UserPromptSubmit hook fires on `--resume` invocations | **Verified**, before release as required: a digest pass entry appears in the second invocation's guard log (fixture `v4-resume.jsonl`), and the e2e smoke's `cc-rsi doctor --live` reported PASS on the first message and on `--resume`. | Hook attestation stays on UserPromptSubmit. `doctor --live` re-checks it on every run (two messages on one context). |
| V5 | SessionStart(`compact`) from `--settings` fires in `-p` children | **Not verified** (reaching auto-compaction is expensive); covered only against the fake `claude`. | The target/frozen Actor's task re-pin depends on the role `pin` hook. The fallback (inject the pin into the next continuation after a compaction is seen) is not implemented. |
| V6 | The stream-json event name for compaction | **Not observed.** | `stream.mjs` flags any `system` event whose subtype matches `/compact/i`; the flag is informational and steers nothing. |
| V7 | Skill `!` injection with a quoted `"${CLAUDE_PLUGIN_ROOT}"` command matches the quoted `allowed-tools` rule | **Not verified at runtime** (the smoke drives the CLI and MCP directly). `claude plugin validate . --strict` accepts the skills. | Skills ship with the quoted form. If a skill is prompted for, the CLI still works from a terminal. |
| V8 | `_meta["claudecode/toolUseId"]` is present on `tools/call` | **Verified in `-p` mode**: the smoke's real session attested and completed `submit` with real hooks; attestation fails closed otherwise. | Attestation by `tool_use_id` is in force. |
| V9 | The PostToolUse `tool_response` shape for MCP tools | **Not verified offline.** | The rewake hook searches `JSON.stringify(tool_response)` for `VERIFICATION RUNNING (job <id>`; no wake otherwise. |
| V10 | Sandbox `denyWrite: [cwd]` plus `allowWrite: [scratch]` is effective | **Not verifiable here** (no bwrap/socat). The live probe's enforcement branch is tested only against the fake. | `doctor --live` runs the live probe whenever the static probe passes. Correctness is unaffected: restore always runs. Sandbox-mode lineages were not run end to end. |
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

**End-to-end smoke** (`CC_RSI_E2E=1`, real `claude` 2.1.296, `--model haiku`, about 18 minutes): all default scenarios passed.

1. `cc-rsi doctor --live`: PASS `live-auth`; PASS `live-hooks` on the first message and on `--resume`.
2. `claude -p --plugin-dir <repo>` with real hooks, MCP attestation and `submit`: verdict PASS, isolation `rollback` (reason "sandbox unavailable: bubblewrap…"), model `claude-haiku-5-5`; the workspace was restored, no lock was left and no `--session-id` was reused.
3. A broad lineage with `--allow-unconfined --foreground`: `budget_exhausted` with one PASS project, a journal commit with tree hashes, `official_evaluator_calls: 0`, about $0.08.
4. SIGTERM mid-wave then resume: not run by default (`CC_RSI_E2E_FULL=1`); the same path is covered with the fake `claude` in `test/cli/explore.test.mjs`.
5. Freeze, a frozen lineage, then `cc-rsi eval run --json-out`: `scored`, score 1, `frozen_intact: true`, score withheld from the piped stdout.

Not covered in this environment: Node 18 (the suites ran on Node 20.20 and 22.22; the code avoids post-18 APIs) and any sandbox-mode run.

## Recorded deviations from the specification

Behaviour that intentionally differs from [design/SPEC.md](design/SPEC.md), as implemented:

- **Manifest version.** `plugin.json` has `"version": "0.1.0"` (the specification said none) because `claude plugin validate --strict` requires it. Installs therefore follow the version, which must be bumped on every release.
- **Preflight exit code.** `explore start` / `explore preflight` without `--yes` exit 3 when blockers exist (0 only when the start would be accepted).
- **`doctor --live`** sends two messages on one context to re-check V4, and adds the live sandbox probe when the static probe passes (up to three tiny calls). It exits 1 when any check fails and also warns on `paused_infra` lineages.
- **Job liveness.** A job whose pid is known on this host and gone is recovered immediately (no 30 s heartbeat wait). A live pid always keeps a job alive unless Linux shows the pid was reused.
- **Lock ordering.** The verification job releases the workspace lock before its final status write, so the Actor never receives a verdict while the lock still denies its next edit. The job result is written before the task transition, so a job that dies after recording a verdict is recovered as `done`.
- **Committed-only memory view.** On tamper, the view shows the last committed history snapshot; the session's inventory is built from the view, so uncommitted memory never reaches the Actor.
- **Main guard tightenings.** `~/.cc-rsi/bin` is exec-only for shell commands; a command that names a locked root is denied even from outside it; Grep/Glob over `~/.claude/projects` is denied while a Verifier session id is known.
- **Interactive Verifier hidden roots** also include `~/.cc-rsi/logs`, every `~/.cc-rsi/work` tree and an external `memory.dir` store.
- **Captures inside parse ops** (see the op journal section), terminal protocol events before the `final` op, Phase-1 branch records under `priv/<wave>/projects/<id>/`, and the extra override `/commits@n`.
- **Configuration.** An invalid value falls back to the next lower layer instead of the default; tighten-only project values are applied last and cannot be loosened by plugin options or flags.
- **CLI additions.** `--project <dir>` on most commands, `verify cancel --grace`, `explore stop --timeout`, `explore abandon --reason`, `cc-rsi help`; `memory import` commits as kind `external`; `gc` keeps anything referenced by a live job or lock.
- **Sealed evaluation additions.** Every attempt runs on a fresh copy; the evaluator runs in its own process group; an interrupt aborts without a record; `--json-out` refuses model-visible destinations; `evaluation.json` may carry `blocked_reason`.
