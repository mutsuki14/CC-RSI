# cc-rsi — implementation specification

Status: final synthesis of the three design proposals and the two judges' verdicts. This document is normative: parallel implementers code against it without coordinating. Where it says MUST, tests assert it.

> Note: this is the original design specification the implementation was built from. Behaviour changed by the review rounds that followed (request capture, transcript protection, lock fencing, practice replay at the Actor's root, plugin-code fingerprinting, and more) is recorded in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#behaviour-of-the-latest-review-round-not-yet-in-the-specification). Where the two disagree, the code and `docs/ARCHITECTURE.md` describe the shipped behaviour.

- Target: Claude Code 2.1.296 (the plugin runs on ≥ 2.1.295, because `onFailure` is required); Node ≥ 18; macOS, Linux and WSL2 (POSIX only).
- Zero runtime npm dependencies. Tests use `node:test` only.
- Plugin name `cc-rsi`. The repo root is both the plugin root and a single-plugin marketplace.
- Upstream: RSIAgent (arXiv:2609.15364) and the prior port dsh-rsi (`/home/user/mutsuki14/dsh-rsi`, Apache-2.0).

---

## 0. Conventions

**Evidence tags.**

| Tag | Meaning |
|---|---|
| [V] | Verified on this machine with 2.1.296 |
| [D] | Documented in the downloaded docs |
| [U] | Unverified. A fallback exists; see §17 |

**Source abbreviations.**

| Abbreviation | Points to |
|---|---|
| CAP | `analysis/claude-code-capabilities.md` |
| EXP | `analysis/claude-code-experiments.md` |
| DSH | `analysis/dsh-rsi-port.md` |
| F1–F7 | probes in `design/proposal-fidelity.md` §1.2 (artifacts in `scratchpad/exp-fid/out/`) |
| R1–R7 | probes in `design/proposal-robust.md` §1.2 (artifacts in `scratchpad/exp-robust/logs/`) |
| PF, PR, PN | the fidelity, robust and native proposals |
| J1-n, J2-n | the n-th must-fix item of judge 1 (fidelity lens) and judge 2 (UX/robustness lens) |
| `prompts/<file>` under `analysis/` | the verbatim prompt dumps |

**JSON.**
- Every JSON file cc-rsi writes uses camelCase keys. The only exceptions are `result.json` (lineages) and `evaluation.json` (sealed runs), which use RSIAgent's snake_case keys so they can be cross-checked against RSIAgent records.
- Timestamps are `new Date().toISOString()`.
- Hashes are lowercase hex sha256.

**Files.**
- Every non-append write is atomic (tmp file in the same directory, fsync, rename, fsync the directory). Use `lib/core/atomic.mjs`.
- Journals are fsync'd JSONL appends that tolerate a torn tail (`lib/core/jsonl.mjs`).
- Under `<home>`, directories are created with mode 0700 and files with 0600. Exceptions: the shim (0755) and read-only views (0444 files, 0555 dirs).

**Code.**
- ESM `.mjs` everywhere except `bin/cc-rsi`, which is CommonJS.
- `package.json` has **no** `"type"` field. An extensionless CJS bin then loads on every Node ≥ 18 (J2-11).
- Do not use `fs.cp` (experimental in Node 18). Use `lib/workspace/copy.mjs`.
- Do not use `--experimental-*` flags.

**Processes.**
- Every detached process (lineage engine, verification job) is spawned with `detached:true`, stdio redirected to a log file, then `unref()`.
- Children of such a process share its process group.
- Shutdown sends SIGINT, waits `graceMs`, sends SIGTERM, waits `graceMs`, then sends SIGKILL (headless.md "Stop a run with SIGTERM").

---

## 1. Decisions

### 1.1 Decisions at a glance

| # | Question | Decision |
|---|---|---|
| 1 | Interactive Verifier | A **headless `claude -p` child only**, run by a detached **verification job** that the `submit` MCP tool starts. There is one Verifier session per task: the first inspection uses `--session-id`, later ones `--resume`. It persists across FAIL→repair→re-verify, across turns and across Claude Code restarts. The job checkpoints the candidate, holds a project-wide workspace lock, restores the candidate (moving displaced copies aside), and owns the verdict. `submit` and `wait_verdict` block for at most 110 s. An async-rewake PostToolUse hook wakes the Actor when the verdict lands [U]. No plugin subagent ships. |
| 2 | Exploration lineages | A **detached Node engine per lineage**. It spawns one `claude -p` per role message (`--session-id` first, `--resume` after) and records every side effect in a **memoized op journal**, so resuming after a crash or stop runs the same code path as the next message. The engine keeps RSIAgent semantics: wave barrier with serial consolidation in authored order, unscored branch restart from immutable fixtures, mandatory fresh retry, STALLED buying exactly one final test, escalation with an asymmetric Verifier swap (no history or report handover), Phase-3 FAIL → same-Actor repair, and infra as a separate outcome class that pauses rather than kills. |
| 3 | Continuation and tokens | One segment is one `claude -p` invocation. `actions` = the number of `tool_use` blocks in its `assistant` events. The reply text is the **final assistant message**, never `result.result` alone (F3, F7). Three consecutive actionless segments without a valid handoff are transport infra; the emergency ceiling is 24 segments. A `max_tokens` turn end gets the truncation continuation and is not counted. Handoff tokens are **unique standalone lines** outside code fences and indented code: `VERDICT:`, `STATUS: SUBMIT`, `DECISION:`. The Phase-1 wave uses dsh's JSON envelope (authored order). |
| 4 | Isolation | Every child runs with `--restricted --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --permission-mode dontAsk --tools <explicit>`. It also gets a per-invocation `--settings` file containing: permissions plus `additionalDirectories`; a **fail-closed role guard** that never emits `allow` (F5); a **UserPromptSubmit digest filter** that also attests the hooks ran; a sandbox block only when the sandbox is in use (`failIfUnavailable:true`); and forwarded auth/provider keys. The environment is allowlisted and `CC_RSI_ROLE` is set. Without an OS sandbox the interactive Verifier degrades **explicitly** to `rollback`. Lineages refuse to run unless `--allow-unconfined` is given (J2-9). |
| 5 | Memory store | `CC_RSI_HOME` (default `~/.cc-rsi`) `/projects/<key>/store`. It does not use `CLAUDE_PLUGIN_DATA`. It is the dsh store ported verbatim with these changes: drafts in external directories; two-step commit (reconcile, then atomic promote with a pending record); journal; history; lease lock; freeze with a hash check; sealed marker; 8-word shingle quarantine; a **UTF-8-ordered** `tree_sha256`; **canonical tamper detection**; conflict re-materialization. The main Actor reads a **read-only materialized view**, never the canonical tree. |
| 6 | Tool surface | MCP server `rsi`, 5 tools: `submit`, `wait_verdict`, `learn`, `memory_commit`, `status`. They are bound to the calling session by **PreToolUse attestation keyed by `tool_use_id`** and matched against `params._meta["claudecode/toolUseId"]` (E9). Role children get **no MCP**: memory is a directory (RSIAgent `~/.memory`). |
| 7 | Hooks | A single dispatcher `hooks/hook.mjs` handles: SessionStart (protocol, inventory, notices, shim), UserPromptSubmit (verbatim capture, task bookkeeping, S0 baseline), PreToolUse (private-path and lock guard; MCP attestation), PostToolUse (async rewake), Stop (nudge/gate), PostModelSwitch (model tracking) and SessionEnd (mark ended). Main-session hooks fail open. Role-child hooks are separate (`hooks/role-guard.mjs`), are installed only through `--settings`, and fail closed. |
| 8 | Entry points | Skills: `/cc-rsi:status`, `/cc-rsi:explore`, `/cc-rsi:memory`, `/cc-rsi:freeze`, `/cc-rsi:doctor`. There is no `commands/` dir, no agents, no workflows, no unfreeze skill and no eval skill. `bin/cc-rsi` is the CLI. Sealed evaluation runs from a terminal only; the score is printed only to a TTY. Human-only subcommands refuse to run under `CLAUDECODE`, and the main guard denies them to model Bash. |
| 9 | Prompts | `prompts/*.md` templates with `{{NAME}}` placeholders, rendered by `lib/prompts`. Sources are RSIAgent texts as dsh-rsi neutralised them. The JSON action protocol is removed and native tools are the action channel. Publication is the final message. Templates are snapshotted per lineage. |
| 10 | Configuration | 3 `userConfig` keys: `verifier_model`, `stop_policy`, `sandbox`. JSON config at `<home>/config.json` (global) and `<project>/.claude/cc-rsi.json` (project). Security keys are global-only; isolation keys may only be tightened by the project file. Defaults live in code. |
| 11 | Testing | `node:test` units per module. A **fake `claude`** binary emulates stream-json, the R3/R4 session semantics, F3/F7 shapes, crashes, hangs, and execution of `--settings` hooks. Also: a crash matrix (including workspace mutation between kill and resume), hook tests with synthetic stdin, MCP protocol tests, `claude plugin validate . --strict`, and an opt-in `--model haiku` e2e. |
| 12 | Honesty | §16 lists every remaining difference from RSIAgent. Every verdict and lineage record states the isolation actually used. |

### 1.2 Rationale and the Claude Code facts each decision relies on

**D1. Interactive Verifier = headless child behind `submit`.**

What it relies on:
- `--session-id` is honoured, and `--resume` keeps context and the same id [V E1/E2, F2].
- A child without `--session-id` inherits the outer CCR session id and appends to the outer transcript [V EXP "Session-ID inheritance"]. So every context MUST mint a fresh uuid.
- `--restricted` keeps OAuth working and confines file tools to the working dirs [V E7, g2].
- `--setting-sources ""` drops project settings, `.mcp.json` and CLAUDE.md [V E8].
- Settings-file hooks fire under `--restricted` [V F1].
- A PreToolUse `allow` overrides `dontAsk` [V F5], so role hooks never emit `allow`.
- Main-conversation MCP calls move to the background after 120 s [D mcp.md:434-450]. This cloud sets `CLAUDE_AUTO_BACKGROUND_TASKS`, which applies that to `-p` too [D env-vars:203]. Hence the bounded 100 s wait (≤ 110 s).
- A per-server `timeout` overrides `MCP_TOOL_TIMEOUT=60000` [V g3].

Why not a plugin subagent:
- Plugin agents ignore `permissionMode`, `hooks` and `mcpServers` [D].
- They inherit the session's permission mode, so the Verifier's Bash prompts would surface in, and widen, the main session [D sub-agents:900-913].
- They run in the background in fork mode [D].
- They have 12 unverified dependencies (PN P1–P12).
- `SubagentHandback` moves the report out of `last_assistant_message` [D hooks.md:2534].
- They cannot be tested offline.

Context persistence across turns and restarts fixes dsh gap 3. The verdict is owned by the job (J1 strength): the Actor never touches the stream, and only the job writes verdict state.

**D2. Engine = detached Node process + `claude -p` per message + op journal.**
- Each message is an atomic, watchdogged and logged segment. Resume is `--resume` [V], and a SIGKILLed child resumes with a synthetic "interrupted" tool_result [V R1].
- A memoized journal (PR §5.2) makes recovery the same code path as normal sends. That fixes dsh gap 6 (lineages not resumable).
- Rejected alternatives:
  - Long-lived stream-json children: process lifetime would carry state, and a dropped pipe looks like a stall.
  - Plugin workflows: no fs access, in-session resume only [D workflows].
  - Subagents: spawn depth 1 in cloud [V E13], and they are tied to the session.

**D3. Final assistant message as handoff.**
- F1: each `assistant` event carries one content block, and `tool_use` blocks are countable.
- F3: `result` can carry synthetic API-error text with `subtype:"success"`.
- F7: a prompt blocked by UserPromptSubmit returns `is_error:false`, `num_turns:0`, no `assistant` event, and a `result` that echoes the harness prompt.
- Consequence (J1-7, J2-1): reply text comes only from assistant events, and an invocation with `num_turns == 0` or no assistant event is infra.
- Harness execution of CLAIM/PROBE leads or check-gate probes is **not** done. Running model-authored commands in the engine would bypass the isolation the lineage records (J1-3). Leads are forwarded as `NOT_RUN`, and the RSIAgent done-check gate is not ported (§16).

**D4. Isolation.**
- Path rules work only on `Read(...)`/`Edit(...)`, and `Edit` authorises Write [V E4/E11].
- `permissions.additionalDirectories` in `--settings` become working dirs under `--restricted` [V F5].
- Sandbox keys in `--settings` are honoured. `failIfUnavailable` exits 1 before any model call. There is no bwrap/socat here [V f1/f2].
- Glob and Grep are absent unless named in `--tools` [V g].
- `--tools` is variadic, as are `--add-dir` and `--allowedTools`. The prompt therefore always goes on **stdin**, and rules and dirs go into the settings file [V f3].
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `_DISABLE_AUTO_MEMORY`, `_DISABLE_CLAUDE_MDS` [D env-vars:245,253].
- `--restricted` ignores user settings files [D cli-reference:125], so auth/provider keys are forwarded explicitly (J2-2).

**D5. Store outside `CLAUDE_PLUGIN_DATA`.**
- `CLAUDE_PLUGIN_DATA` is `…/cc-rsi-inline` under `--plugin-dir` but `…/cc-rsi-<mkt>` when installed, and it is wiped on uninstall [V E5, D].
- `~/.cc-rsi` is stable, survives uninstall (the memory is the user's learned asset), and is outside every workspace.
- Tamper detection plus the read-only view close the write path to canonical memory (J2-3).

**D6. MCP tool binding by `tool_use_id`.** The MCP process keeps its spawn-time session id after `/clear` [D env-vars:382]. `_meta["claudecode/toolUseId"]` is on every `tools/call` [V E9], and PreToolUse carries `tool_use_id` [V]. This replaces PF's unverified `updatedInput` injection into MCP inputs (J1-1).

**D7. Hooks.**
- Exec form (`command:"node"` plus `args`) handles paths with spaces.
- `:` in a matcher forces the regex path, so regex matchers are anchored [D hooks.md:312].
- `UserPromptSubmit` also fires for `<task-notification>` and cross-session messages [V g7]. Those are filtered out.
- SessionEnd shares a 1.5 s budget [D], so it only marks the session ended.
- SubagentStart and SubagentStop are not used, because cc-rsi ships no agents. Subagents of the main session (hook payloads carry `agent_id`) count as part of the Actor: the guard and the workspace lock apply to them, and the MCP state-changing tools refuse them.
- Agents run in the background by default, and interactive fork mode has no `run_in_background` [V g, D]. That is one more reason the Verifier is not a subagent.
- `${user_config.*}` is **not** used in hook args. Hooks read `CLAUDE_PLUGIN_OPTION_<KEY>` (present only when saved [V E5]) and otherwise the code default, which equals the manifest default (J1-6).

**D8. Skills and CLI.**
- Commands and skills are unified in 2.1.296. Skills support `!` injection, `allowed-tools` and `disable-model-invocation` [D skills.md].
- `CLAUDECODE=1` is set in every Claude Code subprocess, including `!` injection and the Bash tool [D env-vars:196]. The CLI uses it to refuse human-only actions (J2-6).
- `bin/` is on the Bash tool's PATH but not on the user's terminal PATH and not proven on the `!` PATH. Skills therefore call `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi"` (J2-10), and SessionStart refreshes a `<home>/bin/cc-rsi` shim for terminals.

### 1.3 Judges' must-fix items and where each is resolved

| Item | Resolution | § |
|---|---|---|
| J1-1 | MCP caller binding via PreToolUse attestation keyed by `tool_use_id` plus `_meta["claudecode/toolUseId"]`. State-changing tools fail closed and refuse callers with an `agent_id` | 11.4 |
| J1-2 | Interactive Verifier scratch is `<home>/vscratch/<verifierSessionId>/`. All of `<home>` except the memory view and the open draft is denied to main-session file tools and Bash path tokens | 4.1, 11.8 |
| J1-3 | The harness executes no probes. Leads are `NOT_RUN`, and that is recorded in every charter | 7.3, 16 |
| J1-4 | The lineage work tree is split into `actor-private/`, `curriculum-private/`, `projects/`, `verify/`, `verify-scratch/`. All Actor-private dirs are in the Verifier's sandbox `denyRead`, the guard's hidden roots and its hidden tokens. Actor memory is deleted before every inspection and re-materialized afterwards | 4.3, 12.7 |
| J1-5, J2 R-shapes | Explicit classes `session_missing` (R3) and `session_conflict` (R4), plus R3 recovery rules | 10.8, 10.9 |
| J1-6 | No `${user_config}` in hook args | 14.1 |
| J1-7 / J2-1 | The handoff comes only from the final assistant message. `num_turns==0`, no init or no assistant event is infra. F3/F7 fixtures ship as tests | 10.7, 10.8, 15 |
| J1-8 / J2-9 | Unconfined lineages need `--allow-unconfined` (or global `isolation.allowUnconfined`) | 12.2 |
| J1-9 | No subagent Verifier ships | — |
| J1-10 | The escalation swap gives the new Verifier neither history nor reports by default (`exploration.escalationHandoverReports:false`) | 12.9 |
| J2-2 | Auth/provider keys from user settings are forwarded into the child `--settings`. `doctor --live` runs a one-call auth probe with the exact role argv and env. An auth failure is classified `auth` | 10.4, 13.5 |
| J2-3 | Read-only memory view for the main Actor, plus `assertCanonicalIntact()` before commits, learning, inspections and lineage steps | 6.6, 11.10 |
| J2-4 | Recursion closure: the CLI, engine and job refuse when `CC_RSI_ROLE` is set; the role guard denies `claude`/`cc-rsi`/`npx @anthropic-ai/claude-code`; children's PATH excludes cc-rsi bins | 10.6, 13.1 |
| J2-5 | Every control-flow fs observation happens inside an op. Crash-matrix variant with workspace mutation | 12.1, 15.3 |
| J2-6 | Human-only subcommands are guard-denied to model Bash and refused under `CLAUDECODE`. No unfreeze skill | 11.8, 13.1 |
| J2-7 | Verdicts record `statusDigest`. Stop, status and learn treat a mismatching digest as stale | 11.3, 11.9 |
| J2-8 | PostModelSwitch hook. Explicit model resolution chain. `init.model` recorded everywhere | 10.3 |
| J2-10 | Skills invoke `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi"` | 13.3 |
| J2-11 | `bin/cc-rsi` is a CJS shim with dynamic import. No `"type"` in package.json. Tested on the oldest Node available | 13.2, 15 |
| J2-12 | Waits ≤ 110 s on every path, and lower under `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | 11.5 |
| J2-13 | Per-tool guard attestation is warn-only and exempts tools absent from `init.tools`. Hook *liveness* is proven by the mandatory UserPromptSubmit guard entry | 10.7 |

Grafts adopted:
- Lossless roles (`DISABLE_AUTO_COMPACT`), with a task pin for the target Actor (PF §5.7).
- `CLAUDE_CODE_RETRY_WATCHDOG` (PF §5.2).
- S0 baseline (PF §4.4).
- CHANGED SINCE YOUR LAST INSPECTION (PN §3.2).
- Project config may only tighten isolation keys (PN §12).
- `explore show` with `--fork-session` hints (PN §4.10).
- Displaced-copy restore and a project-wide workspace lock (PR §4.5/4.8).
- Conflict re-materialization (PR §4.9).
- Shim refresh (PR §11).
- Summarizer worklog and strategy-review pivot (PF §7.4).
- Liveness REPEAT note (PF §6.2).
- Audit of Curriculum handoffs, notes, fixtures and role text (PF §8.6).

---

## 2. Architecture

```
 user terminal                    Claude Code main session  (= ACTOR)                     <home> = $CC_RSI_HOME | ~/.cc-rsi
 ─────────────                    ───────────────────────────────────                     ──────────────────────────────────
 cc-rsi explore start|stop|…      hooks/hook.mjs: SessionStart · UserPromptSubmit ·          projects/<key>/store      (canonical memory, journal,
 cc-rsi eval run (TTY only,         PreToolUse(guard, attest) · PostToolUse(rewake) ·                                    reports, history, frozen/sealed)
   refuses under CLAUDECODE)        Stop · PostModelSwitch · SessionEnd                      projects/<key>/sessions/<sid>  (task.json, requests, jobs,
 cc-rsi doctor --live              mcp/server.mjs "rsi": submit · wait_verdict · learn ·                                 checkpoints, displaced, verdicts)
        │                            memory_commit · status                                  projects/<key>/views/<sid>/memory   (read-only Actor view)
        │                                │ spawn detached                                    projects/<key>/drafts/<episode>     (interactive learning)
        │ spawn detached                 ▼                                                   projects/<key>/lineages/<id>        (records, ops journal)
        ▼                      lib/interactive/verify-job.mjs  (one inspection)              projects/<key>/sealed/<lineage>/<run>
 lib/engine/daemon.mjs <lineage>         │                                                   work/<key>/<id>/  (role cwds: projects/, actor-private/,
        │                                │                                                                     curriculum-private/, verify*/)
        └───────────────┬────────────────┘                                                   vscratch/<verifierSessionId>/   (interactive Verifier scratch)
                        ▼                                                                    run/{att,locks,settings,prompts,policies}/  bin/cc-rsi
          lib/runtime/context.mjs → child.mjs:  claude -p  (one process per role message)
             --session-id|--resume --restricted --setting-sources "" --strict-mcp-config --disable-slash-commands
             --settings <per-invocation> --tools <explicit> --permission-mode dontAsk --append-system-prompt-file <role>
             stdin = message   env = allowlist + CC_RSI_ROLE …   hooks: hooks/role-guard.mjs (prompt|tool|post|pin)
```

**Process model.**
- The main session never runs a Verifier inline.
- Jobs and engines are detached process-group leaders. They outlive the MCP server and the session, write their own state atomically, and clean up their own checkpoints.
- Role children are spawned only by jobs, engines and `doctor --live`.

**Trust boundaries** (each is enforced by the module named in brackets).
1. **Roles hear only the harness.** Child stdin is owned by the job or engine. Every role child's UserPromptSubmit hook blocks a prompt whose sha256 differs from `CC_RSI_EXPECT` [`hooks/role-guard.mjs prompt`].
2. **Verdicts are harness-owned.**
   - The Verifier's final assistant message is parsed by the job or engine [`lib/runtime/stream.mjs`, `lib/protocol/tokens.mjs`].
   - Verdict state is written only by the job (interactive) or the engine (lineage), into `<home>`. All of `<home>` except the read-only view and the open draft is denied to the Actor's file tools and Bash path tokens [`lib/hooks/guard.mjs`].
   - Report text is content-addressed and re-hashed on read [`MemoryStore.getReport`].
3. **Infra is a separate outcome class.** Every invocation is classified before any parse. Infra never becomes PASS/FAIL, never enables `learn`, and never commits memory [`lib/runtime/classify.mjs`, engine and job code paths, tests in §15].
4. **Sealed evaluation runs outside every model context.** It is CLI-only, refuses under `CLAUDECODE`/`CC_RSI_ROLE`, prints the score only to a TTY, and keeps its records under hidden `<home>` paths [`lib/sealed/eval.mjs`].
5. **Memory changes only through commits.** Canonical memory is never exposed writable. The tree hash is compared with the last journal `treeAfter` at every sensitive step [`MemoryStore.assertCanonicalIntact`].

---

## 3. Repository file tree (plugin root = marketplace root)

Owner WP in brackets (§18). One line per file. `*.test.mjs` names are normative.

```
CC-RSI/
  .claude-plugin/plugin.json            [WP7] manifest: name cc-rsi, description, author, homepage, repository, license, keywords, userConfig (3 keys); no version
  .claude-plugin/marketplace.json       [WP7] single-plugin marketplace: {"name":"cc-rsi","owner":{…},"plugins":[{"name":"cc-rsi","source":"./",…}]}
  .mcp.json                             [WP5] stdio server "rsi" → node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs, timeout 600000, alwaysLoad
  hooks/hooks.json                      [WP5] main-session hooks (§11.7)
  hooks/hook.mjs                        [WP5] main-session dispatcher: session-start|prompt|guard|attest|rewake|stop|model|session-end
  hooks/role-guard.mjs                  [WP4] role-child hook (installed only via --settings): prompt|tool|post|pin
  mcp/server.mjs                        [WP5] entry: import('../lib/mcp/server.mjs').main()
  bin/cc-rsi                            [WP7] CommonJS shim: dynamic import of lib/cli/main.mjs
  skills/status/SKILL.md                [WP7] read-only status via !-injection (model-invocable)
  skills/explore/SKILL.md               [WP7] explore subcommands via !-injection (user-only)
  skills/memory/SKILL.md                [WP7] read-only memory inspection (user-only)
  skills/freeze/SKILL.md                [WP7] freeze memory (user-only)
  skills/doctor/SKILL.md                [WP7] diagnostics (user-only)
  prompts/*.md                          [WP2] role/guidance templates (§8.3 lists every file)
  lib/core/paths.mjs                    [WP1] home + project/global layout functions, project key, safe names
  lib/core/config.mjs                   [WP1] defaults, loading, precedence, global-only and tighten-only rules, validation
  lib/core/atomic.mjs                   [WP1] atomic write/read JSON, ensureDir, rmrf, fsyncDir
  lib/core/jsonl.mjs                    [WP1] fsync'd JSONL append (torn-tail safe), tolerant read
  lib/core/lock.mjs                     [WP1] lease lock (dsh semantics) + withLock
  lib/core/ids.mjs                      [WP1] uuid, job/lineage/episode ids, validators, confirm codes
  lib/core/digest.mjs                   [WP1] sha256 helpers (buffer, string, file, canonical JSON)
  lib/core/proc.mjs                     [WP1] pidAlive, spawnDetached, killGracefully, runCapture
  lib/core/log.mjs                      [WP1] file logger (never stdout)
  lib/core/errors.mjs                   [WP1] CcRsiError base, UsageError, LockTimeoutError, HumanOnlyError, RoleContextError
  lib/memory/hash.mjs                   [WP1] canonicalJson (UTF-8 key order), treeSha256, manifestSha256, EMPTY_TREE_SHA256
  lib/memory/safe-path.mjs              [WP1] safeRelativePath (dsh paths.ts)
  lib/memory/tree.mjs                   [WP1] scanTree / pullTree (regular files only, symlink/special/non-UTF-8 rejection, pycache drop)
  lib/memory/errors.mjs                 [WP1] MemoryError family
  lib/memory/store.mjs                  [WP1] MemoryStore (dsh store port + tamper, sealed, rebase, external drafts)
  lib/memory/audit.mjs                  [WP1] shingle corpus + audit of texts/trees
  lib/memory/inventory.mjs              [WP1] inventory listing + formatInventory (dsh)
  lib/memory/view.mjs                   [WP1] materialize read-only view / writable copy of a tree
  lib/protocol/tokens.mjs               [WP2] prose view, unique token parsing, VERDICT/STATUS/DECISION
  lib/protocol/wave.mjs                 [WP2] Phase-1 wave JSON envelope (dsh wave.ts)
  lib/protocol/leads.mjs                [WP2] CLAIM/PROBE parse (dsh scanLeads), MCP leads validation, LEAD block rendering
  lib/prompts/render.mjs                [WP2] template loading (plugin dir or lineage snapshot), {{NAME}} rendering, bundle sha
  lib/prompts/roles.mjs                 [WP2] role prompt builders (§8.2)
  lib/prompts/guidance.mjs              [WP2] interactive MCP result texts (§8.2)
  lib/workspace/copy.mjs                [WP3] copyTree (lstat-based, verbatim symlinks, modes), moveAside, makeReadOnly/Writable, removeTree
  lib/workspace/git.mjs                 [WP3] safe git, projectRoot, workspaceFacts, statusDigest, lsFiles, initInertRepo
  lib/workspace/checkpoint.mjs          [WP3] interactive checkpoint (dsh checkpoint.ts) + displaced-copy restore, persisted to disk
  lib/workspace/fingerprint.mjs         [WP3] treeFingerprint, projectManifest, describeDelta, manifestDelta
  lib/workspace/fixtures.mjs            [WP3] shapeGate, captureTree, replayTree, verifyTree, read-only views
  lib/workspace/baseline.mjs            [WP3] S0 baseline take + delta; CLI entry for detached run
  lib/guard/paths.mjs                   [WP4] physicalPath, isUnder, toolPathArgs, searchCoversHidden (dsh isolation.ts)
  lib/guard/bash.mjs                    [WP4] commandWords, scanBash (hidden paths/tokens, recursion, deny patterns)
  lib/runtime/errors.mjs                [WP4] InfraError, TransportInfraError, InterruptedError
  lib/runtime/claude-bin.mjs            [WP4] resolve claude binary, version, help-flag check
  lib/runtime/env.mjs                   [WP4] child env allowlist / never-pass list
  lib/runtime/auth-settings.mjs         [WP4] forwarded user-scope auth/provider settings
  lib/runtime/policy.mjs                [WP4] role policy JSON for the role guard
  lib/runtime/settings.mjs              [WP4] per-invocation --settings JSON (permissions, hooks, sandbox, forwarded keys)
  lib/runtime/argv.mjs                  [WP4] exact argv builder
  lib/runtime/stream.mjs                [WP4] stream-json parser
  lib/runtime/classify.mjs              [WP4] outcome classification table
  lib/runtime/child.mjs                 [WP4] spawn one invocation, watchdog, logs
  lib/runtime/context.mjs               [WP4] RoleContext (open/send/close, transient retry, recovery note, degrade)
  lib/runtime/converse.mjs              [WP4] same-context continuation loop (injectable send/parse)
  lib/runtime/sandbox.mjs               [WP4] static probe, isolation decision, live probe
  lib/runtime/models.mjs                [WP4] resolveModel (inherit chain), effective(), user-settings model lookup
  lib/interactive/session.mjs           [WP5] session dir helpers, session.json read/write, model resolution for sessions
  lib/interactive/requests.mjs          [WP5] requests.jsonl capture + task message selection
  lib/interactive/task.mjs              [WP5] task.json state machine under the session lock
  lib/interactive/attest.mjs            [WP5] write/take attestation records
  lib/interactive/wslock.mjs            [WP5] project-wide workspace locks (run/locks)
  lib/interactive/verify-job.mjs        [WP5] detached verification job (run | recover)
  lib/interactive/memview.mjs           [WP5] main-session read-only memory view refresh
  lib/mcp/jsonrpc.mjs                   [WP5] newline-delimited JSON-RPC 2.0 framing
  lib/mcp/server.mjs                    [WP5] MCP protocol + tool dispatch
  lib/mcp/tools.mjs                     [WP5] tool definitions + handlers (submit, wait_verdict, learn, memory_commit, status)
  lib/hooks/common.mjs                  [WP5] stdin JSON read, output helpers, role no-op, fail-open wrapper, timing
  lib/hooks/session-start.mjs           [WP5]
  lib/hooks/prompt.mjs                  [WP5]
  lib/hooks/guard.mjs                   [WP5] main-session PreToolUse guard
  lib/hooks/attest.mjs                  [WP5]
  lib/hooks/rewake.mjs                  [WP5]
  lib/hooks/stop.mjs                    [WP5]
  lib/hooks/model.mjs                   [WP5]
  lib/hooks/session-end.mjs             [WP5]
  lib/engine/journal.mjs                [WP6] OpJournal (memoized ops, overrides, blobs)
  lib/engine/records.mjs                [WP6] lineage.json/state.json/events/result writers, createLineage, admission (resume)
  lib/engine/roles.mjs                  [WP6] per-role RoleSpec builders for lineages, EngineContext (journaled sends, restarts)
  lib/engine/steps.mjs                  [WP6] journaled converse wrapper, handoff phase, leads round
  lib/engine/inspect.mjs                [WP6] practice (replay) and target (live) protected inspections
  lib/engine/learn.mjs                  [WP6] same-Actor learning (distill → reconcile → diagnosis → commit loop)
  lib/engine/project.mjs                [WP6] practice project (Phase 1 branch / Phase 2 practice) with unscored restart
  lib/engine/target.mjs                 [WP6] target attempt (deep + frozen), stall, resume, escalation swap
  lib/engine/worklog.mjs                [WP6] worklog synthesis (summarizer, strategy review, digest fallback)
  lib/engine/broad.mjs                  [WP6] Phase 1 waves
  lib/engine/deep.mjs                   [WP6] Phase 2 deep loop
  lib/engine/frozen.mjs                 [WP6] Phase 3 frozen lineage
  lib/engine/daemon.mjs                 [WP6] detached entry: lease, signals, dispatch by phase, pause/finish
  lib/sealed/eval.mjs                   [WP7] sealed evaluation
  lib/cli/main.mjs                      [WP7] argv parsing, dispatch, role refusal, human-only refusal
  lib/cli/status.mjs                    [WP7]
  lib/cli/doctor.mjs                    [WP7]
  lib/cli/memory.mjs                    [WP7]
  lib/cli/explore.mjs                   [WP7] preflight/start/status/log/stop/resume/abandon/show/list
  lib/cli/eval.mjs                      [WP7]
  lib/cli/gc.mjs                        [WP7]
  lib/cli/shim.mjs                      [WP7] writeShim(home, pluginRoot) (also used by SessionStart)
  scripts/run-tests.mjs                 [WP7] collects test/**/*.test.mjs and runs node --test <files>
  package.json                          [WP7] {"name":"cc-rsi","private":true,"license":"Apache-2.0","engines":{"node":">=18"},"scripts":{"test":"node scripts/run-tests.mjs","smoke":"CC_RSI_E2E=1 node scripts/run-tests.mjs test/e2e"}}
  README.md                             [WP8] English user guide
  README.zh.md                          [WP8] Chinese user guide
  docs/ARCHITECTURE.md                  [WP8] architecture, invariants, differences from RSIAgent
  NOTICE                                [WP8] credits RSIAgent (arXiv:2609.15364, Apache-2.0) and dsh-rsi
  LICENSE                               [WP8] Apache-2.0 text
  test/_helpers/tmp.mjs                 [WP1] tmpdir/env helpers
  test/_helpers/spawn.mjs               [WP1] runNode helper
  test/_helpers/fake.mjs                [WP4] fake-claude env setup and log reader
  test/fake-claude/claude               [WP4] executable (#!/usr/bin/env node, CJS → imports claude.mjs)
  test/fake-claude/claude.mjs           [WP4] fake claude implementation (§15.2)
  test/fake-claude/scenarios/*.mjs      [WP4 base set; WP5/WP6 add their own under their test dirs]
  test/fixtures/streams/*.jsonl         [WP4] copied real streams: F1 run1, F3 run3, F7 run10, R3 run3 (+ .err)
  test/core/*.test.mjs                  [WP1]
  test/memory/*.test.mjs                [WP1]
  test/protocol/*.test.mjs              [WP2]
  test/prompts/*.test.mjs, golden/      [WP2]
  test/workspace/*.test.mjs             [WP3]
  test/runtime/*.test.mjs               [WP4]
  test/guard/*.test.mjs                 [WP4]
  test/interactive/*.test.mjs, scenarios/ [WP5]
  test/hooks/*.test.mjs, payloads/      [WP5]
  test/mcp/*.test.mjs                   [WP5]
  test/engine/*.test.mjs, scenarios/    [WP6]
  test/sealed/*.test.mjs                [WP7]
  test/cli/*.test.mjs                   [WP7]
  test/plugin/*.test.mjs                [WP7] manifest checks, validate --strict, defaults parity, import boundaries
  test/e2e/*.test.mjs                   [WP7] opt-in real smoke (CC_RSI_E2E=1)
```

**Import boundaries.** `test/plugin/boundaries.test.mjs` parses the `import` lines and enforces these rules:
- `lib/core` imports only `node:*`.
- `lib/memory`, `lib/protocol` and `lib/workspace` import only `node:*`, `lib/core` and their own package.
- `lib/guard` imports `node:*` and `lib/core`.
- `lib/prompts` imports `node:*`, `lib/core` and `lib/protocol`.
- `lib/runtime` imports `node:*`, `lib/core`, `lib/guard`, `lib/prompts` and `lib/memory/hash.mjs`.
- `lib/runtime/child.mjs` is the **only** module that spawns `claude`.
- `lib/hooks/*` and `hooks/*.mjs` import only `lib/core`, `lib/guard`, `lib/interactive/{session,requests,task,attest,wslock,memview}.mjs`, `lib/prompts`, `lib/memory/*`, `lib/workspace/git.mjs`, `lib/runtime/{sandbox,models}.mjs` and `lib/cli/shim.mjs`. They never import `lib/engine` or `lib/runtime/{child,context}.mjs`. Hooks start other programs (job recovery, baseline) only as detached processes by file path.
- `hooks/role-guard.mjs` imports only `lib/core` and `lib/guard`.
- `lib/engine` never imports `lib/interactive`, `lib/mcp` or `lib/hooks`.
- `lib/interactive` never imports `lib/engine`.

---

## 4. Runtime filesystem layout

### 4.1 Global (`<home>` = `resolve($CC_RSI_HOME)` else `~/.cc-rsi`)

```
<home>/.gitignore                       "*"  (written once with flag wx)
<home>/config.json                      global config (§14)
<home>/probe.json                       sandbox probe cache {v:1, platform, bwrap, socat, sandboxExec, static:{available,reason}, live?:{ccVersion, available, reason, at}}
<home>/bin/cc-rsi                       POSIX sh shim → latest plugin root (0755)
<home>/logs/hooks.log, mcp.log, cli.log, jobs.log
<home>/run/att/<tool_use_id>.json       MCP attestations (0600; swept after 1 h)
<home>/run/locks/<sha24(root)>.json     workspace locks (§11.6)
<home>/run/settings/<sha256>.json       content-addressed child settings
<home>/run/prompts/<sha256>.md          content-addressed rendered system prompts
<home>/run/policies/<sha256>.json       content-addressed role policies
<home>/vscratch/<verifierSessionId>/    interactive Verifier scratch (+ tmp/ = TMPDIR)
<home>/work/.git                        inert repo (git init -q, core.hooksPath=/dev/null) so role git never discovers ~/.git
<home>/work/<key>/<lineageId>/          lineage role cwds (§4.3)
<home>/projects/<key>/                  per-project state (§4.2)
```

`<key>` = `projectKey(root)` = `safeBase(basename(root)) + "-" + sha256(root).slice(0,12)`. `safeBase` replaces `[^A-Za-z0-9._-]` with `_` and truncates to 40 chars.
- `root` = `projectRoot(dir)` (§9.2), the dirname of the realpath of `git rev-parse --git-common-dir` (all worktrees share memory), else `realpath(dir)`.
- `dir` is `CLAUDE_PROJECT_DIR` (hooks, MCP), else the hook payload `cwd`, else the CLI's `--project` or cwd.
- Global config `memory.dir` overrides the store root only.

### 4.2 Per project (`<P>` = `<home>/projects/<key>`)

```
<P>/project.json                        {v:1, key, root, createdAt}
<P>/store/                              MemoryStore root (§6.2)
<P>/sessions/<sid>/session.json         §11.1
<P>/sessions/<sid>/requests.jsonl       {seq, ts, promptId, text}
<P>/sessions/<sid>/task.json            §11.2
<P>/sessions/<sid>/.lock                session LeaseLock
<P>/sessions/<sid>/jobs/<jobId>.json    §11.5   (+ <jobId>.log)
<P>/sessions/<sid>/checkpoints/<jobId>/ entries.json + files/ (deleted after restore)
<P>/sessions/<sid>/manifests/t<NNN>-g<NNN>.json   candidate manifest per inspection (for CHANGED SINCE …)
<P>/sessions/<sid>/displaced/<jobId>/   moved-aside versions of restored/created files
<P>/sessions/<sid>/baselines/b-<seq>.json  S0 baselines
<P>/sessions/<sid>/verdicts.jsonl       §11.5 step 9
<P>/sessions/<sid>/ctx/<safeCtxKey>/…   interactive Verifier invocation logs (§10.9)
<P>/views/<sid>/memory/                 read-only view of canonical memory (+ ../view.json {treeSha256, at})
<P>/drafts/<safeEpisode>/               interactive learning draft dirs
<P>/lineages/<id>/                      §12.3
<P>/sealed/<lineage>/<runId>/           §13.4
```

### 4.3 Lineage work tree (`<W>` = `<home>/work/<key>/<lineageId>`; role-visible)

```
<W>/curriculum-private/                 Curriculum cwd
      memory/                           read-only copy of canonical (absent when curriculumMemoryAccess=none)
      authoring/<id>/                   Phase-1 fixture trees authored per wave (wiped per wave after capture)
      practice/authoring/               Phase-2 practice fixture root (wiped per decision after capture)
      notes.md                          optional private Curriculum notes
<W>/actor-private/<ep>/memory/          Actor memory: read-only snapshot copy in work phases, store draft in learning
<W>/projects/<ep>/                      Actor cwd = PROJECT_ROOT (practice replay root or target root)
<W>/verify/<ep>/candidate/              practice Verifier cwd (fresh replay of the captured candidate per inspection)
<W>/verify/<ep>/original/               read-only original fixtures (Phase-2 practice)
<W>/verify-scratch/<ep>-<vk>/           Verifier scratch (practice: wiped per inspection; target: persists per Verifier context)
<W>/summarizer/                         empty cwd for summarizer calls
```
`<ep>` is `w<NNN>-<pid>`, `w<NNN>-<pid>-a<n>` (unscored restart attempt n ≥ 2), `t<NNN>` or `p<NNN>`. `<vk>` is the Verifier context index.

Hidden roots per role (guard `hidden`, sandbox `denyRead`, settings `permissions.deny` as `Read(//…/**)`), computed at each invocation:

| Role | hidden |
|---|---|
| all roles | `<home>/projects`, `<home>/run`, `<home>/bin`, `<home>/config.json`, `<home>/vscratch` (a Verifier instead gets every `<home>/vscratch/<x>` except its own scratch), `<HOME>/.claude/projects`, `<HOME>/.claude/.credentials.json`, `$CLAUDE_CONFIG_DIR/projects` (if set), every other lineage's `<home>/work/<key>/<other>` |
| Actor `<ep>` | `<W>/curriculum-private`, `<W>/verify`, `<W>/verify-scratch`, every `<W>/actor-private/<other>`, every `<W>/projects/<other>` |
| Verifier on `<ep>` | `<W>/curriculum-private`, `<W>/actor-private`, every `<W>/projects/<x>` except its own live root (target), every `<W>/verify/<x>` and `<W>/verify-scratch/<y>` except its own |
| Curriculum | `<W>/actor-private`, `<W>/projects`, `<W>/verify`, `<W>/verify-scratch` |
| Summarizer | everything above (it has no tools) |

Hidden **tokens** are a literal heuristic for relative traversal in Bash, for example `../../actor-private`:
- Actor: `curriculum-private`, `verify-scratch`, `/verify/`.
- Verifier: `actor-private`, `curriculum-private`.
- Curriculum: `actor-private`, `verify-scratch`.
- All roles: `/.cc-rsi/projects`, `/.cc-rsi/run`, `.claude/projects`, `.claude/.credentials`.
- Non-Verifier roles also get `/.cc-rsi/vscratch`.

Each role's own cwd, addDirs and scratch are passed as `allowedPaths`. `scanBash` (§10.6) masks these before matching, so a role can always name its own directories.

---

## 5. `lib/core` — shared primitives (WP1)

Every function below is exported with exactly this name and signature. "async" means it returns a Promise. Sync variants exist only where noted (hooks use them on the hot path).

### 5.1 `paths.mjs`
```js
export function ccRsiHome(env = process.env): string                 // resolve(env.CC_RSI_HOME) || join(os.homedir(), '.cc-rsi')
export function globalLayout(home): {
  home, gitignore, config, probe, bin, binShim /* <home>/bin/cc-rsi */, logs, hooksLog, mcpLog, cliLog, jobsLog,
  run, att, locks, settings, prompts, policies, vscratch, work, projects }
export function projectKey(root: string): string
export function projectLayout(home, key, { storeDir } = {}): {
  dir, projectJson, store /* storeDir ?? <dir>/store */, sessions, views, drafts, lineages, sealed,
  work /* <home>/work/<key> */ }
export function sessionLayout(pl, sid): {
  dir, sessionJson, requests, task, lock, jobs, checkpoints, manifests, displaced, baselines, verdicts, ctx,
  viewDir /* <pl.views>/<sid>/memory */, viewJson /* <pl.views>/<sid>/view.json */ }
export function lineageLayout(pl, id): {
  dir, lineageJson, stateJson, ops, blobs, events, result, engineLock, engineLog, ctx, priv, promptsSnapshot,
  W /* <pl.work>/<id> */, curriculum, curriculumMemory, authoring, practiceAuthoring, notes,
  actorMemory(ep), projectRoot(ep), verifyCandidate(ep), verifyOriginal(ep), verifyScratch(name), summarizer }
export function safeName(s: string): string        // [^A-Za-z0-9._-] → '_'; if > 120 chars: first 111 + '-' + sha256(s).slice(0,8)
export function isUnderLexical(child, parent): boolean   // both resolved; child === parent or startsWith(parent + sep)
```

### 5.2 `config.mjs` (schema and defaults in §14)
```js
export const DEFAULTS: object                       // deep-frozen; §14.2
export const GLOBAL_ONLY: string[]                  // dotted keys/prefixes honoured only from <home>/config.json (or CLI)
export const TIGHTEN_ONLY: Record<string, {order?: string[], intersect?: true}>
export function loadConfig({ home, projectRoot, userConfig = {}, cli = {} }): { config, warnings: string[], sources: object }
export function userConfigFromEnv(env, prefix /* 'CLAUDE_PLUGIN_OPTION_' | 'CC_RSI_OPT_' */): { verifier_model?, stop_policy?, sandbox? }
export function getKey(config, dotted): any
export function configSha(config): string            // sha256(canonicalJson(config))
```
`loadConfig` steps:
1. Start from `DEFAULTS` and deep-merge `<home>/config.json`.
2. Deep-merge `<projectRoot>/.claude/cc-rsi.json`, dropping GLOBAL_ONLY keys with a warning.
3. Deep-merge non-empty `userConfig` values mapped through `USERCONFIG_MAP = {verifier_model:'models.verifier', stop_policy:'interactive.stopPolicy', sandbox:'isolation.sandbox'}`.
4. Deep-merge `cli`.
5. For each TIGHTEN_ONLY key, if the project value is stricter than the result, take the project value. Strictness comes from the `order` index, or set intersection for `intersect`.
6. Validate types and ranges. Invalid values revert to the default with a warning; unknown keys produce a warning.

Missing or malformed files produce a warning, never a throw.

### 5.3 `atomic.mjs`, `jsonl.mjs`, `digest.mjs`, `ids.mjs`, `log.mjs`, `errors.mjs`
```js
// atomic.mjs
export async function ensureDir(dir, mode = 0o700)
export async function writeFileAtomic(path, data, { mode = 0o600 } = {})
export async function writeJsonAtomic(path, value, { mode = 0o600 } = {})   // JSON.stringify(value, null, 2) + '\n'
export async function readJson(path, fallback)        // ENOENT → fallback; malformed → throws CcRsiError('json_malformed')
export async function readJsonSafe(path, fallback)    // any error → fallback
export function readJsonSafeSync(path, fallback); export function writeJsonAtomicSync(path, value, opts)
export async function rmrf(path); export async function exists(path); export async function fsyncDir(dir)
// jsonl.mjs
export async function appendJsonl(path, value, { fsync = true } = {})  // prefixes '\n' if the file's last byte is not '\n'
export async function readJsonl(path): object[]       // ENOENT → []; unparseable lines skipped
export function appendJsonlSync(path, value); export function readJsonlSync(path)
// digest.mjs
export function sha256Hex(data: string|Buffer): string; export async function sha256File(path): string
// ids.mjs
export function uuid(): string                        // crypto.randomUUID()
export function newJobId(now = new Date()): string    // 'j-YYYYMMDDhhmmss-' + 6 hex
export function defaultLineageId(phase, now = new Date()): string   // `${phase}-YYYYMMDDhhmmss`
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export function confirmCode(): string                 // 6 lowercase hex
export function pad3(n): string
export function interactiveEpisode(sid, taskSeq, gen): string        // `task-${sid.slice(0,8)}-${taskSeq}-g${gen}`
// log.mjs
export function createLogger(file, component): { info(msg, data?), warn(msg, data?), error(msg, data?) }   // sync JSONL append, never throws, never stdout
// errors.mjs
export class CcRsiError extends Error { constructor(code: string, message: string, details = {}) }  // .code, .details
export class UsageError extends CcRsiError {}
export class LockTimeoutError extends CcRsiError {}
export class HumanOnlyError extends CcRsiError {}     // message: 'cc-rsi: "<cmd>" is human-only: run it in a terminal outside Claude Code'
export class RoleContextError extends CcRsiError {}   // message: 'cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)'
```

### 5.4 `lock.mjs` — lease lock (port of dsh `store.ts:175-181,336-399`)
```js
export class LeaseLock {
  constructor(path, { leaseMs = 30000, heartbeatMs = 5000, waitMs = 60000, pollMs = 50, owner = {} } = {})
  async acquire({ wait = true } = {}): boolean       // false only if !wait and the lock is held live; throws LockTimeoutError after waitMs
  async release(): void                              // compare token, unlink, stop heartbeat
  get held(): boolean
  static async inspect(path): null | { holder: {pid, host, token, at, owner}, stale: boolean, reason: string }
  static async forceRelease(path): boolean           // human/doctor use only
}
export async function withLock(path, fn, opts): any
```
- The file is created with `open(path, 'wx')` and holds `{pid, host, token: "<processNonce>:<rand>", at, owner}`.
- The holder `utimes` it every `heartbeatMs`.
- It is stale when any of these holds:
  - mtime is older than `leaseMs`;
  - it is torn or unparseable and older than 5 s;
  - its token carries this process's nonce but is not in this process's held set;
  - it has the same pid and host but lacks our nonce;
  - it is on the same host and `kill(pid,0)` gives ESRCH.
- Takeover is compare-and-delete: re-read, require equality with the stale snapshot, unlink, then retry `wx`.

### 5.5 `proc.mjs`
```js
export function pidAlive(pid): boolean               // process.kill(pid, 0); EPERM → true
export function spawnDetached(cmd, args, { cwd, env, logFile }): number   // detached:true, stdio ['ignore', fd, fd], unref; returns pid
export async function killGracefully(pid, { graceMs = 10000, group = false } = {}): 'gone' | 'exited' | 'killed'
                                                      // SIGINT → wait graceMs → SIGTERM → wait graceMs → SIGKILL; group → kill(-pid)
export async function runCapture(cmd, args, { cwd, env, timeoutMs = 15000, maxBuffer = 32 * 2**20, input } = {}):
  { code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean }
```

---

## 6. Memory store (`lib/memory`, WP1) — the dsh store ported with additions

### 6.1 Hash (`hash.mjs`), byte-compatible with RSIAgent `tree_sha256` (MEM §6)
```js
export const EMPTY_TREE_SHA256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
export function canonicalJson(value): string        // sorted keys by UTF-8 bytes (Buffer.compare), separators ',' ':',
                                                    // JSON.stringify string escaping (≙ ensure_ascii=False), no NaN/Infinity
export function treeSha256(map: Record<string, string>): string
       // validates every entry: key non-empty, no leading '/', no '..' segment; value /^[0-9a-f]{64}$/ → else MemoryStateError
export function manifestSha256(manifest: Record<string, {bytes:number, sha256:string}>): string
       // RSIAgent memory_manifest_sha256: sorted keys, ',' ':', ensure_ascii=TRUE (non-ASCII → \uXXXX lowercase; astral → surrogate pairs)
export class MemoryStateError extends Error {}
```
Test vectors (MUST pass):
- `{}` → `44136fa3…af8a`.
- `{"a.md": "hello\n"}` → `baf97b40a6e87d94d244e1d0a69c822e5005af35e6c14630d1d63728a436cfd8`.
- The 4-file tree (`INDEX.md`, `lessons/fail-01.md`, `procedures/x.md`, `scripts/run.sh`) → `6d2d3f96…8a1e`.
- `！.md / 😀.md / Z.md / a.md / é.md` → `20b3f2cc25d1e9dc7b864f7de5ac9c69b167c0fabb801f8b4d868e8c0cca746f`. JS default sort gives `f4d20f37…`, which MUST NOT be produced.
- The `.hidden / B-x.md / B.md / B/c.md / B/sub/d.md` tree → `61d58dd6fdff98dd37bbae563d3b8322b25de998ab12b7be66a59a6e06efaf75`.
- The dsh vector `{'b/lesson.md': sha256('fail fast'), 'a.md': sha256('科学 notes')}` → `c9cedc356c2e9259636f2e7a9b8ce36819a10fbf2e8e889fd1a011dbf9386a9e`.

### 6.2 Store layout (`<store>` = `<P>/store`, or global `memory.dir`)
```
memory/                         canonical tree (schema-free, Actor-owned content)
drafts/<safeEpisode>.json       draft meta {v:1, episode, dir, baseHash, baseManifest:{rel:{bytes,sha256}}, createdAt,
                                 owner:{kind:'engine'|'session', pid, host, sessionId?, lineage?}}  — written last, removed first
journal.jsonl                   CommitRecord per line (§6.4)
commit.pending.json             {v:1, record}  while an install is in flight
history/<NNNN>/                 full snapshot of canonical after commit NNNN (keepHistory)
quarantined/<safeEpisode>       absorbing marker (content: ISO timestamp only; never the reason)
reports/<sha256>.md             content-addressed Verifier reports
frozen.json                     {v:1, treeHash, frozenAt, by}
sealed.json                     {v:1, runs:[{lineage, runId, at}], learningAfterSealed: boolean}
inventory.json                  cache {v:1, treeSha256, files:[{path, bytes}], totalBytes, at} — rewritten after every install
audit_rejects.jsonl             {ts, episode?, lineage?, surface, file?, kinds:[...]} — never matched content
.lock                           LeaseLock
.staging-<nonce>/ .backup-<nonce>/   transient
```

### 6.3 API (`store.mjs`)
```js
export class MemoryStore {
  static async open(root, { limits = {maxFiles:400, maxTotalBytes:4194304, maxFileBytes:65536}, keepHistory = true,
                            sealedTextFiles = [], shingleWords = 8, logger, lockOptions } = {}): Promise<MemoryStore>
       // ensureDir, then under lock: recovery (§6.5). Does NOT throw on tamper; callers call assertCanonicalIntact().
  get root(): string; get memoryDir(): string
  async treeHash(): string                                  // tree_sha256 of canonical (scanTree)
  async expectedTreeHash(): string                          // last journal record's treeAfter, else EMPTY_TREE_SHA256
  async assertCanonicalIntact(): void                       // throws MemoryTamperError{expected, actual}
  async inventory({ refresh = false } = {}): {treeSha256, files:[{path,bytes}], totalBytes}   // from inventory.json unless refresh
  async openDraft(episode, { dir, fresh = false, owner }): Draft
       // under lock: frozen → MemoryFrozenError; sealed && !learningAfterSealed → MemorySealedError; quarantined → MemoryQuarantineError;
       // fresh → discard existing; existing meta with same dir and dir present → reuse; else rm dir (must not be a symlink; must not be
       // inside <store>), copy canonical into dir (writable), write meta {baseHash, baseManifest}.
  async getDraft(episode): Draft | undefined
  async discardDraft(episode): void                         // rm meta first, then dir (only if dir is not canonical/history)
  async rebaseDraft(episode): { prevDir: string, draft: Draft }   // rename dir → dir + '.prev' (replacing an older .prev), then openDraft(fresh)
  async commit(episode, { kind, outcome = null, origin = null, lineage = null }): CommitRecord   // §6.4
  async journal(): CommitRecord[]; async findCommit(episodeOrOrigin): CommitRecord | undefined
  async isQuarantined(episode): boolean
  async auditTexts(texts: string[], { surface, lineage, episode }): boolean   // true = hit (also writes audit_rejects + nothing else)
  async freeze({ by }): { treeHash }; async unfreeze({ afterSealed = false }): void   // unfreeze asserts frozen-intact first
  async frozen(): { treeHash, frozenAt, by } | null; async assertFrozenIntact(): void   // MemoryFrozenTamperError
  async sealed(): object | null; async markSealed({ lineage, runId }): void
  async putReport(text): string /* sha */; async getReport(sha): string | undefined   // re-hash; altered → undefined
  async acceptExternal({ by }): CommitRecord                // journals kind 'external' with treeBefore=expected, treeAfter=actual
  async restoreHistory(n, { by }): CommitRecord             // installs history/NNNN atomically; journals kind 'restore'
  async history(): [{ n, treeSha256, at }]
  async close(): void                                       // stops lock heartbeats
}
// Draft = { episode, dir, baseHash, baseManifest, createdAt, owner }
```
Errors (`errors.mjs`), all extending `MemoryError extends CcRsiError`:

| Error | Meaning / payload |
|---|---|
| `MemoryFrozenError` | the store is frozen |
| `MemorySealedError` | used for sealed evaluation |
| `MemoryConflictError{baseHash, currentHash}` | the draft's base is no longer canonical |
| `MemoryLimitError{detail}` | `detail` is human text such as "412 files > 400; 'notes/big.md' 70211 bytes > 65536" |
| `MemoryQuarantineError` | message exactly: `this learning phase could not be promoted; durable memory is unchanged` |
| `MemoryTamperError{expected, actual}` | canonical changed outside a commit |
| `MemoryFrozenTamperError` | the frozen tree changed |
| `MemoryDraftMissingError` | no draft for the episode |
| `UnsafeMemoryPathError{path}` | unsafe name in the tree |
| `MemoryStateError` | from `hash.mjs` |

### 6.4 Commit (two-step: the Actor reconciles first, then the atomic promote). This is dsh `store.ts:644-715` plus additions.

`commit(episode, {kind, outcome, origin, lineage})`, run as `#serial(#locked(...))`:
1. If frozen → `MemoryFrozenError`. If sealed and not `learningAfterSealed` → `MemorySealedError`. Then `assertCanonicalIntact()` → `MemoryTamperError`.
2. `#resolvePending()` (§6.5).
3. Idempotence: if the journal has `episode`, or a record whose `origin` or `episode` equals `origin`, discard the draft and return that record.
4. Draft meta missing → `MemoryDraftMissingError`. Quarantined episode → `MemoryQuarantineError`.
5. **Pull** the draft dir with `pullTree(dir)`:
   - regular files only;
   - a symlink or special file anywhere → `UnsafeMemoryPathError`;
   - names must pass `safeRelativePath` and be valid UTF-8 with no lone surrogates;
   - drop `__pycache__/`, `*.pyc`, `*.pyo`.
6. Limits → `MemoryLimitError{detail}`. The draft is kept so the same Actor can condense it.
7. Audit (when a sealed corpus exists): any draft file sharing a shingle → write `quarantined/<episode>` (and `<origin>`) durably, append `audit_rejects.jsonl`, discard the draft, then `MemoryQuarantineError`.
8. Conflict: if canonical hash ≠ `draft.baseHash` → `MemoryConflictError` (the draft is kept; callers use `rebaseDraft`).
9. Build the record:
   ```js
   CommitRecord = {v:1, seq, episode, origin, kind: 'practice'|'target'|'task'|'external'|'restore',
                   outcome: 'PASS'|'FAIL'|null, lineage, ts, files, bytes, treeBefore, treeAfter,
                   created: string[], modified: string[], deleted: string[]}
   ```
   `created`, `modified` and `deleted` are sorted by UTF-8 bytes.
10. Install:
    1. Write the pulled files into `.staging-<nonce>` in sorted order and fsync the tree.
    2. Write `commit.pending.json` (atomic).
    3. Rename `memory` → `.backup-<nonce>`, then `.staging-<nonce>` → `memory`. If that fails, rename the backup back, remove staging and pending, and rethrow.
    4. `#journalize(record)`, which is idempotent per episode and newline-safe.
    5. `history/<NNNN>` copy if `keepHistory` (NNNN = seq, 4 digits).
    6. Rewrite `inventory.json`.
    7. Remove pending, then backup.
    8. `discardDraft(episode)`.

### 6.5 Recovery on `open` (under lock; dsh `store.ts:236-297` plus additions)
1. If `memory/` is missing and a `.backup-*` exists → rename the newest backup to `memory/`. If neither exists → create an empty `memory/`.
2. Delete `.staging-*`. Delete `.backup-*` when `memory/` exists.
3. `#resolvePending`:
   - a torn or missing marker → nothing;
   - else if the canonical hash == `record.treeAfter` → journalize and drop its draft;
   - always remove the marker.
4. Sweep drafts:
   - delete `*.json.tmp`;
   - keep a draft only if the meta is valid, the episode is not committed, the dir exists, and the owner is live;
   - liveness: `owner.kind==='engine'` → the pid is alive on this host; `owner.kind==='session'` → `<P>/sessions/<sessionId>` exists;
   - otherwise remove the meta, then the dir. Never touch a dir under `<store>/memory` or `history`.
5. Rebuild `inventory.json` if it is missing or its `treeSha256` ≠ the canonical hash.

### 6.6 Tamper detection (new in cc-rsi; J2-3)
`assertCanonicalIntact()` compares `treeHash()` with `expectedTreeHash()`. It MUST be called:
- in SessionStart (warn only);
- in `learn` and `memory_commit` (refuse);
- in `submit` (warn in the result, do not refuse);
- in `commit` (refuse);
- in the engine at lineage start, resume admission, before each wave/target/practice and before each commit (pause with infra class `memory_tamper`).

Remedies, both human-only:
- `cc-rsi memory verify --accept-external` → `acceptExternal`.
- `cc-rsi memory restore <N>` → `restoreHistory`.

### 6.7 Tree helpers (`tree.mjs`), `audit.mjs`, `inventory.mjs`, `view.mjs`, `safe-path.mjs`
```js
// tree.mjs
export async function scanTree(root, { drop = DEFAULT_DROP } = {}):
  { files: Record<rel, {bytes, sha256, mode}>, treeSha256 }      // missing root → {files:{}, treeSha256: EMPTY}; rejects like pullTree
export async function pullTree(root): Record<rel, Buffer>       // same rules, returns contents
export const DEFAULT_DROP = (rel) => /(^|\/)__pycache__(\/|$)/.test(rel) || /\.py[co]$/.test(rel)
export function diffManifests(before, after): { created, modified, deleted, unchanged }   // sorted UTF-8
// safe-path.mjs
export function safeRelativePath(p): string     // trim; '\\'→'/'; reject '', NUL, absolute, drive letter, '..'; collapse '.'/'' segments; ≤240 chars
// audit.mjs
export function words(text): string[]           // lowercase, split /[^\p{L}\p{N}]+/u, drop empties
export function buildCorpus(texts: string[], n = 8): Set<string>   // n-word shingles joined by ' '; n clamped ≥ 3
export function hits(corpus, text, n): boolean
export async function loadSealedCorpus(files: string[], n): Set<string> | null   // null when no files or empty
// inventory.mjs
export function formatInventory(files: [{path, bytes}], limit = 40): { lines: string[], omitted: number }
       // '  <bytes>  <path>' sorted UTF-8; names containing '{' or '}' omitted (dsh); "… N more files" line when truncated
// view.mjs
export async function materializeView(srcDir, destDir, { readOnly = true } = {}): { treeSha256 }
       // rm dest (non-symlink), copy regular files, chmod files 0444 / dirs 0555 when readOnly
export async function viewTreeHash(destDir): string | null
```

---

## 7. Protocol parsing (`lib/protocol`, WP2)

All parsers return `Parsed<T> = { ok: true, value: T } | { ok: false, detail: string }`. `detail` is a precise English sentence that is fed back verbatim through a continuation (dsh detail strings, `analysis/prompts/dsh-protocol.md` "transport detail strings").

### 7.1 `tokens.mjs`
```js
export function ok(value); export function fail(detail)
export function proseLines(text): string[]
   // split /\r?\n/; drop lines inside ``` or ~~~ fences (closing fence: same char, length ≥ opener; an unterminated fence swallows to EOF);
   // drop lines indented by TAB or ≥4 spaces; blockquote lines ('>' after optional spaces) are KEPT but never match a token.
   // Literal "\n" sequences are NOT reinterpreted.
export function normalizeTokenLine(line): string   // trim; strip ONE layer of wrapping ** / __ / * / _ / ` (same char both ends); trim
export function parseUniqueToken(text, pattern /* RegExp, full-line, case-insensitive, group 1 = value */, { allowed } = {}):
   Parsed<{ value: string /* UPPERCASE */, lineIndex: number /* index in the ORIGINAL text lines */ }>
   // collect all prose lines whose normalized form fully matches; none → fail('your reply had no standalone line "<NAME>: …"
   // outside code fences'); differing values → fail('your reply contained conflicting <NAME> lines (A, B)'); value ∉ allowed →
   // fail('<NAME>: X is not available here; use one of …'). Identical repeats are fine.
export function parseVerdict(text, { allowUnverified }): Parsed<{ verdict: 'PASS'|'FAIL'|'UNVERIFIED', report: string }>
   // pattern /^VERDICT:\s*(PASS|FAIL|UNVERIFIED)$/i ; report = the whole text (trimmed) — never edited, summarized or capped
export function parseSubmit(text): Parsed<{ body: string }>
   // pattern /^STATUS:\s*(SUBMIT)$/i ; body = text without the token line(s), trimmed (private: never forwarded to a Verifier)
export function parseDecision(text, allowed: string[]): Parsed<{ decision: string, body: string, rationale: string }>
   // pattern /^DECISION:\s*([A-Z_]+)$/i ; body = original lines AFTER the (first) token line, verbatim, trimmed;
   // rationale = lines before it, trimmed. PROJECT requires a non-empty body.
```

### 7.2 `wave.mjs` (port of dsh `src/protocol/wave.ts`)
```js
export const PROJECT_ROOT_TOKEN = '<PROJECT_ROOT>'
export function parseWave(text, { ceiling }): Parsed<{ decision: 'WAVE'|'SATURATED'|'STALLED', rationale: string,
                                                       projects: [{ id, instruction }] }>
```
- The candidate JSON is the content of the LAST fenced block whose content parses as an object; else the substring from the first `{` to the last `}`.
- Shape: `{decision, rationale, projects:[{id, instruction}]}`.
- Ids match `ID_RE` and are unique.
- WAVE requires 1 ≤ |projects| ≤ ceiling, and every instruction contains `<PROJECT_ROOT>`. The ceiling is disclosed only in the failure detail.
- SATURATED and STALLED require `projects: []`.
- Authored order = array order.

### 7.3 `leads.mjs` (port of dsh `src/engine/steps.ts` scanLeads/formatLeads)
```js
export function parseLeads(text): { leads: [{ claim, probe }], problems: string[] }   // CLAIM:/PROBE: pairs; fenced multi-line probes;
                                   // inline fences; an unterminated fence never swallows; unfenced heredoc/backslash continuation rejected
                                   // as a problem; '<<<' allowed; at most 16 leads (extra → problem)
export function validateLeadArgs(arr): { leads: [{ claim, probe }], problems: string[] }   // MCP evidence_leads; same limits
export function formatLeads(leads): string
   // blocks joined by a blank line (RSIAgent core/loop.py:447-465 shape):
   // LEAD n
   // Actor-stated claim: <claim>
   // Exact reproducible probe proposed by Actor:
   // --- BEGIN PROBE ---
   // <probe>
   // --- END PROBE ---
   // Harness execution classification: NOT_RUN
export const LEADS_REQUEST_FORMAT: string   // the CLAIM/PROBE format paragraph used in prompts (dsh leadsRequest)
```
The harness never executes a probe. `NOT_RUN` is the only classification cc-rsi emits (J1-3).

---

## 8. Prompts (`prompts/*.md`, `lib/prompts`, WP2)

### 8.1 Rendering (`render.mjs`)
```js
export const PROMPT_NAMES: string[]                  // every file in prompts/ without '.md' (§8.3), sorted
export function promptsDir(): string                 // <pluginRoot>/prompts (resolved from import.meta.url)
export async function snapshotPrompts(destDir): Record<name, sha256>   // copy all templates (lineage snapshot)
export function setPromptsDir(dir): void             // engine: render from the lineage snapshot
export function loadTemplate(name): { text, sha256 }  // sync read + cache; unknown name → PromptError
export function render(name, vars = {}): string
   // Placeholders: {{UPPER_SNAKE}}. Missing var → PromptError. A var passed but unused → PromptError (strict; catches typos).
   // Values are inserted verbatim (no escaping). '{{' with no closing '}}' is literal. Trailing newline of the file is kept.
export function bundleSha(): { [name]: sha256 }
export class PromptError extends Error {}
```
Templates are plain Markdown/text. There is no conditional or loop syntax: conditional fragments are separate files that builders compose.

### 8.2 Builders (`roles.mjs`, `guidance.mjs`). All return strings. Callers MUST use these instead of `render` directly.
```js
// shared
epistemic()
memoryPreamble({ memoryDir, inventory: { lines, omitted }, empty })          // RSIAgent memory_preamble; empty → empty variant
memoryRevisit(event /* 'verifier'|'fold'|'recovery'|'stagnation' */, { memoryDir })
// interactive
actorProtocol({ mode /* 'learn'|'frozen' */, allowUnverified, memoryViewDir })   // SessionStart context (≤ 6000 chars)
taskPin({ messages /* [{text, current}] */ })                                    // SessionStart(compact) re-pin
// engine Actor
engineSystem()                                                                   // lineage Actor + Curriculum system append
actorRuntimeContract({ projectRoot, memoryDir })
practiceActorCharter({ instruction /* <PROJECT_ROOT> already substituted */, projectRoot, memoryDir, inventory, empty })
targetActorOpening({ target, projectRoot, memoryDir, inventory, empty, frozen })
resumeOpening({ changed, worklog, review, target, projectRoot, memoryDir })     // handoff or pivot + memoryRevisit('recovery') + opening without preamble
summarizerSystem(); summarizerRequest({ currentLog, messages /* [{who:'YOU'|'ENV', text}] */ })
strategyReviewSystem(); strategyReviewAsk({ worklog, tail })
disagreement({ report, memoryDir, memoryNonEmpty })                             // + memoryRevisit('verifier') when non-empty
unverified({ report })                                                          // evidence_request=True wording
leadsRequest({ interactive })                                                   // engine: CLAIM/PROBE lines + STATUS: SUBMIT; interactive: evidence_leads arg
distillation({ outcome, report, memoryDir, limits, owner /* 'engine'|'actor' */, confirmCode })
reconciliation({ memoryDir, owner, confirmCode })
diagnosis()
conflict({ prevDir, draftDir, owner, confirmCode })
limitCondense({ detail, memoryDir, owner, confirmCode })
transportContinuation({ role /* 'ACTOR'|'CURRICULUM' */, detail, token /* e.g. 'STATUS: SUBMIT' */ })
stallContinuation({ role, token })
truncatedContinuation()
recoveryNote({ message })                                                       // embeds the original message (R1/F4-safe)
repeatWarning()
// Verifier
verifierSystem({ location /* 'live'|'replay' */, sandbox /* boolean */, allowUnverified })
verifierCharter({ generation, task /* string, already formatted */, candidateRoot, scratchDir, mechanical, changedSinceLast,
                  leads /* formatted LEAD blocks | '' */, priorReports /* string[] */, handover /* 'self'|'other-verifier'|null */,
                  originalFixturesDir, practiceContext /* '' | text */ })
interactiveTask({ messages: [{ seq, text, current }] })                          // '[user message i of n, latest]' labels; earlier-context labels
verifierPracticeContext({ phase /* 1|2 */, evidenceRound /* boolean */ })
verifierContinuation({ detail, allowUnverified })
// Curriculum
curriculumSystem()
curriculumRuntimeContract({ cwd, authoringRoot, notesFile })
waveCharter({ direction, targetConditioned, priorWave /* text|'' */, authoringRoot, memoryDir /* null when none */, notes })
waveContinuation({ detail, authoringRoot })
deepCharter({ target, history /* text */, latestOutcome, notes, memoryAccess /* 'read_only'|'none' */, authoringRoot, memoryDir })
curriculumContinuation({ detail })
phase1RecoveryNotice()
outcomeText({ instruction, verdict, reports, memoryChanges, diagnosis })
waveOutcomes({ wave, rationale, outcomes: string[] })
targetOutcomeText({ target, verdict, report, diagnosis, lifecycle /* boolean */ })
// guidance.mjs (interactive MCP results; WP5 calls these)
guidanceVerdict({ verdict, report, generation, isolation, model, memoryNonEmpty, memoryDir, mode, restored, displaced, detectOnly,
                  staleDigestNote, tamperNote })
guidanceRunning({ jobId, generation, elapsedSec })
guidanceInfra({ cls, detail, remedy })
guidanceRefusal(kind, args)      // kinds: 'not_attested','subagent','role','learning_open','frozen','sealed','no_terminal_verdict',
                                 // 'stale_verdict','already_learned','quarantined','tamper','bad_confirm','no_learning','unverified_not_learnable'
guidanceLearnStart({ outcome, report, draftDir, limits, confirmCode })        // distillation(owner actor) + code line
guidanceCommitResult(kind, args) // kinds: 'reconcile','promoted','already','limit','conflict','quarantined','frozen','abandoned'
```

### 8.3 Template files and their sources

Paths in the "Source" column are relative to `scratchpad/analysis/prompts/`. "RSIAgent" cites the upstream file:line given in those dumps. **General adaptation rules (apply to every file):**
- **(A1)** Remove the JSON action protocol: `PLAIN_JSON_TRANSPORT_NOTE`, ONE_ACTION and multi-program nudges, dry-turn nudges, `{"program":…}` and Look/Ask JSON, PLAN pinning, and budget lines. Native tools are the action channel: Bash = Program (output plus exit status), Read on images and PDFs = native Look.
- **(A2)** Replace guest paths:
  - `/home/user/evolution_project` → `{{PROJECT_ROOT}}` in Actor texts and `<PROJECT_ROOT>` in Curriculum instructions;
  - `~/.memory` and `/host/frozen` → `{{MEMORY_DIR}}`;
  - handoff files (`~/actor_handoff.md`, `phase1_wave.json`, `project_next.md`, `learning_diagnosis.md`) → "your final message".
- **(A3)** "Publish/leave the handoff at <path>" → "end your work with a final message that contains the standalone line `<TOKEN>`".
- **(A4)** No benchmark nouns (OSWorld, desktop, VM, screenshot, Overleaf, GLM, K3, Kimi). Keep dsh's neutral wording where dsh already rewrote it.
- **(A5)** Never disclose budgets, ceilings, wave concurrency or the sealed evaluator.
- **(A6)** Keep RSIAgent sentences verbatim wherever they are benchmark-independent: verdict semantics, external-service rollback rule, continuity paragraph, distillation and reconciliation contracts.

| Template file | Used by | Source (verbatim base) | Change |
|---|---|---|---|
| `epistemic.md` | Actor system/protocol, Verifier system | `dsh-epistemic.md` (RSIAgent `core/actor.py:19` EPISTEMIC_CORE, E1–E6) | none |
| `memory-preamble.md`, `memory-preamble-empty.md` | Actor openings, interactive context | `actor-charters.md` §1 (`explore/charter.py:10`), `learning-memory-surfaces.md` §4, `dsh-actor.md` memoryPreamble | A2; the retrieval sentence names Read/Grep/Bash; add "edits to this directory are discarded"; placeholders `MEMORY_DIR`, `LISTING` |
| `memory-revisit-verifier.md`, `-fold.md`, `-recovery.md`, `-stagnation.md` | continuations, FAIL guidance, compaction pin, liveness | `actor-nudges.md` §5 (`core/loop.py:231-250`), `learning-memory-surfaces.md` §5 | A2 |
| `actor-protocol.md` (+ `actor-protocol-learn.md`, `actor-protocol-frozen.md`, `actor-protocol-unverified.md`) | interactive SessionStart | `dsh-actor.md` §actorProtocol (3 renderings) | `rsi_submit`→`submit`, `rsi_learn`→`learn`, `rsi_memory_commit`→`memory_commit` (MCP tools of server cc-rsi); "the same Verifier context inspects every revision of this task, across turns"; "while a verification runs, file edits and shell commands are paused: call wait_verdict"; memory is a read-only directory `{{MEMORY_DIR}}` (no memory tools); confirm codes; "UNVERIFIED → call submit again with evidence_leads (CLAIM/PROBE)"; frozen variant drops learning |
| `task-pin.md` | SessionStart(compact) | `actor-resume-worklog.md` §1 "Task pin above the work log" (`core/loop.py:970`) | "TASK (verbatim, unchanged — this is the actual goal):" + messages |
| `engine-system.md` | lineage Actor and Curriculum (`--append-system-prompt-file`) | `actor-system.md` §2/§3 (`core/actor.py:76` _SYSTEM_TEMPLATE, `:226` _DISCIPLINE_LINE, `:55` native Look bullet), `dsh-actor.md` engineActorSystem | A1; keep EPISTEMIC_CORE and METHOD; "your final message is your handoff" |
| `actor-runtime-contract.md` | every practice/target Actor opening | `isolation-runtime-contracts.md` §2 (`explore/practice_loop.py:484`), `dsh-actor.md` actorRuntimeContract | A2; "edits to your memory directory during work are discarded" |
| `practice-actor-charter.md` | practice Actor (Phase 1/2) | `actor-charters.md` §2 (`explore/charter.py:590`), `dsh-actor.md` practiceActorCharter | A2, A3 (`STATUS: SUBMIT`, neutral: claims neither success nor failure) |
| `target-actor-opening.md` | target Actor (Phase 2) | `protocol-target-attempt.md` §1a/§1b (`memory_preamble` + `opening_message(budget=None)`), `dsh-actor.md` targetActorCharter | A2, A3 |
| `frozen-actor-opening.md` | Phase-3 frozen Actor | `protocol-frozen-mode.md` §1a/§1b | A2, A3; no learning lines |
| `resume-handoff.md`, `resume-pivot.md`, `resume-appendix.md` | stalled target resume | `actor-resume-worklog.md` §2 (`core/actor.py:285` handoff_message, `:318` pivot_handoff_message, `core/loop.py:1753` appendix), `dsh-actor.md` resumeHandoffMessage/resumePivotMessage | "machine" → "project root and environment"; worklog cap 12000 / 6000 chars |
| `summarizer-system.md`, `summarizer-request.md` | worklog synthesis | `actor-resume-worklog.md` §1 (`core/actor.py:240` SUMMARIZER_SYSTEM; fold request `core/loop.py:87-91`) | `[YOU]/[ENV]` rendering; "Programs" → "tool calls" |
| `strategy-review-system.md`, `strategy-review-ask.md` | pivot resume | `actor-resume-worklog.md` §2 (`core/actor.py:297,302`) | none beyond A1 |
| `disagreement.md` | interactive FAIL guidance; frozen FAIL repair | `actor-verifier-feedback.md` §1 (`core/verifier.py:1684`), `verifier-feedback-to-actor.md` A, `dsh-actor.md` disagreementMessage | "declare done again" → "submit again" (interactive) / "end with STATUS: SUBMIT" (engine): two endings, `disagreement-tail-interactive.md` and `disagreement-tail-engine.md`; no items punch list |
| `unverified.md` (+ `unverified-tail-interactive.md`, `unverified-tail-engine.md`) | UNVERIFIED feedback | `actor-verifier-feedback.md` §2 (`core/verifier.py:1701`, evidence_request=True), `verifier-feedback-to-actor.md` B, `dsh-actor.md` unverifiedMessage | the same two endings; "a file you author about your own work proves nothing" kept verbatim |
| `leads-request-engine.md`, `leads-request-interactive.md` | after UNVERIFIED | `dsh-actor.md` leadsRequest; `actor-done-protocol.md` §5 | interactive: the `evidence_leads` argument format |
| `distillation.md` (+ `distillation-tail-engine.md`, `distillation-tail-actor.md`) | learning step 1 | `learning-distillation.md` (`explore/charter.py:1164`), `actor-charters.md` §4, `dsh-actor.md` distillationMessage | A2 (draft dir); limits paragraph (dsh); actor tail: "edit {{DRAFT_DIR}} with your file tools, then call memory_commit with confirm {{CONFIRM_CODE}}"; engine tail: "end your turn when finished" |
| `reconciliation.md` (+ the two tails) | learning step 2 | `learning-reconciliation.md` (`explore/charter.py:1205`), `dsh-actor.md` reconciliationMessage | as above |
| `diagnosis.md` | Phase-2 learning step 3 | `learning-diagnosis.md` (`explore/charter.py:1232`), `dsh-actor.md` learningDiagnosisMessage | the diagnosis is your final message, not a file |
| `conflict.md` | commit conflict (re-materialized draft) | new (PR §4.9) | "Canonical memory changed while you were learning. Your previous draft is preserved at {{PREV_DIR}}; {{DRAFT_DIR}} now holds the current memory. Re-apply your changes there …" |
| `limit-condense.md` | MemoryLimitError | `dsh-protocol.md` steps detail "the reconciled draft cannot be promoted: … Condense, merge, or delete …" | adds `{{DETAIL}}` and the limits |
| `continuation-transport.md` | Actor/Curriculum unusable handoff | `isolation-runtime-contracts.md` §3 (`explore/practice_loop.py:501`), `actor-nudges.md` §7, `dsh-actor.md` transportContinuation | A3; "This is not a correctness grade … No fixed retry count applies." verbatim |
| `continuation-stall.md` | liveness override after a pause | `isolation-runtime-contracts.md` §4 (`practice_loop.py:510`), `dsh-actor.md` stallContinuation | A3 |
| `continuation-truncated.md` | max_tokens turn end | `dsh-actor.md` truncatedContinuation | none |
| `continuation-recovery.md` | recovering sends | new (PR §5.2) | "HARNESS RECOVERY: the harness was interrupted while delivering or awaiting your reply to the message below. Claude Code may show an interrupted tool call; its outcome is unknown, so check the current state yourself. If you already acted on the message, continue from where you are; otherwise act on it now. This is not a grade.\n--- MESSAGE ---\n{{MESSAGE}}" |
| `repeat-warning.md` | role PostToolUse liveness | `actor-nudges.md` §3 REPEAT_WARNING (`core/actor.py:267`) | "program" → "command" |
| `verifier-system.md` (+ `verifier-unverified-clause.md`, `verifier-private.md`) | every Verifier | `verifier-system.md` A/B/D (AGENTIC_VERIFIER_SYSTEM) + J (private suffix), `dsh-verifier.md` verifierSystem | The JSON program/report channel paragraph becomes: "Investigate with your tools (Read, Grep, Glob, Bash). Your final message is your complete report and must contain exactly one standalone line VERDICT: PASS, VERDICT: FAIL, or VERDICT: UNVERIFIED outside quotes and code blocks. Publishing ends this inspection." Scratch = `$VERIFIER_SCRATCH`. No `sandbox_permissions` text. Glob/Grep are available. The UNVERIFIED clause is included only when allowed |
| `verifier-mechanics-live-sandbox.md` | interactive/target Verifier with sandbox | `verifier-system.md` E (`_EFFECT_ISOLATION_DESCRIPTION`), PR §7.3 sandbox text | "commands run in an OS sandbox with no network; harness-private paths unreadable; treat the workspace as read-only; it is checkpointed and restored" |
| `verifier-mechanics-live-rollback.md` | interactive/target Verifier without sandbox | `verifier-system.md` F (`_ROLLBACK_MIRROR_DESCRIPTION`), PR §7.3 rollback text | keep the external-service rule and "a property created only by your own test is not candidate evidence" verbatim; "Your shell commands are NOT sandboxed: network access and other processes are NOT isolated" |
| `verifier-mechanics-replay-sandbox.md`, `verifier-mechanics-replay-unconfined.md` | practice Verifier | `verifier-practice.md` A1 + `verifier-system.md` F rule | "You inspect a fresh copy of the captured candidate; the capture is preserved, so changes to this copy are discarded …" plus sandbox or not-isolated sentence |
| `verifier-charter.md` (+ `verifier-charter-continuity.md`, `-continuity-other.md`, `-prior-reports.md`, `-handover-reports.md`, `-original-fixtures.md`, `-leads.md`, `-changed.md`) | each inspection | `verifier-charter-candidate.md` A/B (`explore/charter.py:803`; continuity `:986-997`; leads `:922-944`), `dsh-verifier.md` verifierCharter (verbatim structure), PN §3.3 (CHANGED SINCE YOUR LAST INSPECTION) | adds `CANDIDATE ROOT: {{CANDIDATE_ROOT}}`, `YOUR PRIVATE SCRATCH DIRECTORY: {{SCRATCH_DIR}} ($VERIFIER_SCRATCH)`, and the publish sentence; NOT_RUN lead classification sentence ("the harness did not execute these probes") |
| `verifier-practice-context-1.md`, `-2.md`, `-evidence.md` | practice mechanical context | `verifier-practice.md` A1, A2, A3 | "fresh VM" → "fresh copy of the captured candidate" |
| `verifier-continuation.md` | Verifier transport recovery | `verifier-transport.md` "Same-context transport recovery" (`core/verifier.py:784`) + AGENTIC_VERIFIER_PREMATURE_DONE, `dsh-verifier.md` verifierTransportContinuation | "verifier-report Program" → "final message"; drop Look/pixel variants and the archived-tail sentence |
| `curriculum-system.md` | Curriculum system append | `curriculum-system.md` (roles/curriculum.yaml + build_system), `dsh-curriculum.md` curriculumSystem | A1 |
| `curriculum-runtime-contract.md` | every Curriculum charter | `isolation-runtime-contracts.md` §1 (`practice_loop.py:460`), `dsh-curriculum.md` | owned root = `{{AUTHORING_ROOT}}`; notes file `{{NOTES_FILE}}` |
| `notes-block.md` | Curriculum charters | `dsh-curriculum.md` notesBlock | none |
| `wave-charter.md` (+ `wave-charter-distribution.md`, `wave-charter-first.md`) | Phase-1 Curriculum | `curriculum-wave.md` (`explore/charter.py:1265`, target-conditioned default, distribution-guided diff, empty-history default) + SATURATED criteria (`charter.py:313-323`), `dsh-curriculum.md` waveCharter | the JSON envelope goes in a fenced block of the final message; fixture trees under `{{AUTHORING_ROOT}}/<id>/`; "projects run in parallel and are consolidated in the order you list them" |
| `wave-continuation.md` | wave transport | `curriculum-wave.md` §continuation (`explore/phase1_wave.py:171`), `isolation-runtime-contracts.md` §6, `dsh-curriculum.md` waveContinuation | A3 |
| `deep-charter.md` (+ `deep-charter-memory-none.md`, `deep-charter-defaults.md`) | Phase-2 Curriculum | `curriculum-practice-selection.md` A (`self_evolving_curriculum_charter(phase2_outcome=True)`, `charter.py:242`), B (memory none diff), C (empty defaults), `dsh-curriculum.md` deepCharter + DEEP_DECISIONS | "DECISION: PROJECT\|READY_FOR_TARGET\|STALLED on its own line; for PROJECT the project text follows the DECISION line"; fixture root `{{AUTHORING_ROOT}}` |
| `curriculum-continuation.md` | deep decision transport | `curriculum-decision-formats.md` (`practice_loop.py:501,522`), `dsh-curriculum.md` curriculumTransportContinuation | A3 |
| `phase1-recovery-notice.md` | resume after a Curriculum context loss | `curriculum-decision-formats.md` "Phase-1 completed-boundary resume notice" (`practice_loop.py:1355-1364`) | operator wording → harness wording |
| `outcome.md`, `wave-outcomes.md`, `target-outcome.md`, `lifecycle-transition.md` | Curriculum inputs | `dsh-protocol.md` lineage outcome texts (`_outcome_text` `practice_loop.py:1002`, `_memory_changes` `phase1_wave.py:491`), `curriculum-wave.md` PREVIOUS_WAVE_OUTCOMES (`phase1_wave.py:783-803`), `target_learning._outcome_text` (`:152`), `protocol-frozen-mode.md` §5 LIFECYCLE TRANSITION (`unified_evolution.py:485-499`) | none |
| `guidance-pass.md`, `guidance-fail-tail.md`, `guidance-unverified-tail.md`, `guidance-running.md`, `guidance-infra.md`, `guidance-harness-note.md`, `guidance-refusals.md` (one `## kind` section per refusal), `guidance-commit.md` (one section per kind) | MCP results | `dsh-host-messages.md` §rsi_submit, §rsi_learn, §rsi_memory_commit; INFRASTRUCTURE wording from PF §4.2 | tool names; the first line of every verdict result: `cc-rsi · Verifier: VERDICT: <V> (generation <g>, isolation=<mode>, model=<m>)`; infra: `INFRASTRUCTURE: the independent inspection could not reach a verdict (<class>). This is not a verdict about your work. <remedy>` |

`test/prompts/render.test.mjs` asserts:
- Every builder renders with a fixed input set and matches `test/prompts/golden/<builder>.txt`. WP2 generates the goldens and reviews them by hand.
- No rendered prompt contains `/home/user`, `evolution_project`, `~/.memory`, `OSWorld`, `json action`, `"program":`, `rsi_handoff`, `rsi_submit`, `PLAIN_JSON` or `max_iters`. No prompt sent to a role states a numeric budget or ceiling: a regex `/\b(budget|ceiling)\b[^.\n]*\d/i` must not match, and an explicit, commented allowlist covers any verbatim RSIAgent sentence that needs the word.
- Every file in `prompts/` is referenced by some builder.

---

## 9. Workspace (`lib/workspace`, WP3) — ports of dsh `host/git.ts`, `host/checkpoint.ts`, `engine/fixtures.ts`, `engine/workspace.ts`

### 9.1 `copy.mjs`
```js
export async function copyTree(src, dest, { filter = () => true, verbatimSymlinks = true, preserveMode = true } = {})
   // lstat-based recursive copy; dest must not exist or is replaced only by callers; special files skipped (reported)
export async function removeTree(path)                       // rm -rf, restoring write bits first when needed
export async function moveAside(dir, intoDir, prefix = 'attempt_'): string   // rename to <intoDir>/<prefix>NNN (next free); missing src → null
export async function makeReadOnly(dir); export async function makeWritable(dir)   // clear/restore write bits (dirs after children)
```

### 9.2 `git.mjs`
```js
export async function safeGit(cwd, args, { timeoutMs = 15000, maxBuffer = 32 * 2**20 } = {}): { stdout: string } | undefined
   // argv: git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c diff.external=
   //       ...driverOverrides(cwd) ...args ; env: process.env + GIT_TERMINAL_PROMPT=0 GIT_EXTERNAL_DIFF= GIT_OPTIONAL_LOCKS=0,
   //       minus GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE. Any failure or timeout → undefined.
export async function driverOverrides(cwd): string[] | undefined   // dsh: neutralise non-global/system filter.*/diff.* drivers;
   // git < 2.26 → neutralise all found; config unreadable AND rev-parse fails → undefined (callers must not run git)
export async function gitTopLevel(dir): string | null
export async function projectRoot(dir): string                    // dirname(realpath(--git-common-dir)) or realpath(dir)
export async function lsFiles(root, { exclude = [] } = {}): { files: string[], ignoredDirs: string[] } | undefined
   // ls-files -z --cached --others --exclude-standard ; ignored: ls-files -z --others --ignored --exclude-standard --directory
export async function workspaceFacts(root, { exclude = [], maxLines = 200 } = {}): { text: string, git: boolean }
   // dsh workspaceState text: "Candidate root: …\nUNCOMMITTED CHANGES (git status --porcelain, N):\n  …\n\nDIFF STAT:\n…" |
   // "no uncommitted changes" | "No usable git repository: file-change capture is unavailable; inspect the live state directly."
export async function statusDigest(root, { exclude = [], timeoutMs = 3000 } = {}): string | null
   // sha256( porcelain -z --untracked-files=all --ignore-submodules=all output + for each listed path in sorted order
   //         '\0' + path + '\0' + size + '\0' + mtimeMs (lstat; missing → '-') ); null if not git, timeout, or failure
export async function initInertRepo(dir)                          // git -c core.hooksPath=/dev/null init -q dir (once) + .gitignore '*'
```

### 9.3 `checkpoint.mjs` (interactive candidate protection; dsh `checkpoint.ts` + displaced-copy restore)
```js
export class Checkpoint {
  static async take(root, { dir, exclude = [], maxBytes = 268435456, maxFiles = 20000 }): Checkpoint
  static async load(dir): Checkpoint
  get root(); get detectOnly(); get method() /* 'git'|'walk' */; get takenAt()
  fingerprint(): string                       // sha256 over sorted [rel, size, mode, sha256|mtimeMs] of entries
  manifest(): Record<rel, { size, mode, sha256: string|null }>
  async compare(): { changed: string[], created: string[], deleted: string[] }
  async restore({ displacedDir }): { restored: string[], displaced: string[], failed: [{ path, error }], skipped: string[] }
  async dispose(): void                       // rm dir (entries.json + files/)
}
```
**Persisted layout** (`dir`):
- `entries.json`: `{v:1, root, method, detectOnly, takenAt, entries:{rel:{size, mtimeMs, mode, sha256|null}}, blocked:[dirs], ignoredDirs:[…]}`.
- `files/<rel>`: copies.

**`take`.**
- Listing method: `git` via `lsFiles`, else a walk that skips `.git`, `node_modules`, `.venv` and `__pycache__`.
- Unreadable directories are recorded as `blocked`.
- Every file is lstat'd. Above either cap → detect-only (size, mtime and mode, no copies).
- Otherwise each file is copied with its sha256.

**`restore`.**
- For each changed or deleted entry that has a copy:
  1. If a current version exists, **move** it to `displacedDir/<rel>`.
  2. Copy the checkpoint copy to `<file>.cc-rsi-restore`, chmod it, rename it into place.
- For each created path that did not pre-exist, **move** it to `displacedDir/<rel>`. A path counts as pre-existing if it lies under a blocked dir, is under `ignoredDirs`, or has birthtime < takenAt − 2 s.
- Never delete anything.
- Individual failures go to `failed`.
- Detect-only checkpoints report `skipped`.

### 9.4 `fingerprint.mjs`
```js
export async function treeFingerprint(root): string        // everything incl. .git: sorted walk; [type, rel, mode, size+sha256 | link target]
export async function projectManifest(root, { limit = 5000 } = {}): { files: Record<rel, {size, mtimeMs}>, truncated: boolean }
   // ignores .git, node_modules, .venv, __pycache__
export function manifestDelta(before, after): { created: string[], modified: string[], deleted: string[] }
export function describeDelta(delta, { maxLines = 200, header }): string
   // "FILE-CHANGE EVIDENCE <header>:\nCREATED: …\nMODIFIED: …\nDELETED: …" or "No file changes detected <header>."
export function contentDelta(prevManifest, curManifest): { created, modified, deleted }   // {rel:{size, sha256}} manifests
```

### 9.5 `fixtures.mjs` (dsh `engine/fixtures.ts`)
```js
export async function shapeGate(root, { allowInternalSymlinks = false } = {}): string | null
   // null = ok; else a detail: missing, a symlink, not a directory, contains links/special files, or has no regular file
export async function captureTree(root, dest): { files: Record<rel, {bytes, sha256}>, dirs: string[] }
   // rm dest; copy root → dest/tree (verbatim symlinks only if allowed); write dest/manifest.json
export async function replayTree(captureDir, root)           // rm root; copy tree; verifyTree or throw CcRsiError('replay_mismatch')
export async function verifyTree(captureDir, root): boolean   // exact file set, contents and dirs
export async function stageReadOnlyView(captureDir, viewDir); export async function removeView(viewDir)
```

### 9.6 `baseline.mjs` (S0 baseline; PF §4.4)
```js
export async function takeBaseline(root, { maxFiles = 20000, hashLimitBytes = 2 * 2**20 } = {}):
  { v:1, root, method, takenAt, complete: true, truncated: boolean, files: Record<rel, [size, mtimeMs, sha256|null]> }
export async function baselineDelta(baseline, root, { exclude = [] } = {}): string
   // "FILE-CHANGE EVIDENCE since this task began (baseline captured <ms> ms after the task opened): CREATED … MODIFIED … DELETED …"
// CLI: `node lib/workspace/baseline.mjs <root> <outFile> <openedAtIso>` → writes JSON atomically (+ capturedAfterMs)
```

---

## 10. Headless role runtime (`lib/runtime`, `lib/guard`, `hooks/role-guard.mjs`; WP4)

### 10.1 Binary (`claude-bin.mjs`)
```js
export function resolveClaudeBin({ config, env = process.env }): string
   // config.children.claudeBin (global-only) || env.CC_RSI_CLAUDE_BIN (tests) || env.CLAUDE_CODE_EXECPATH when basename starts with
   // 'claude' (same version as the parent) || 'claude'
export async function claudeVersion(bin): string | null      // `<bin> --version` → '2.1.296'; cached per process
export async function missingFlags(bin): string[]            // REQUIRED_FLAGS absent from `<bin> --help`
export const REQUIRED_FLAGS = ['--restricted','--setting-sources','--strict-mcp-config','--mcp-config','--session-id','--resume',
  '--append-system-prompt','--tools','--settings','--permission-mode','--output-format','--verbose','--disable-slash-commands',
  '--include-hook-events','--no-session-persistence']
```

### 10.2 Exact child command line (`argv.mjs`)
```js
export function buildArgv({ first, sessionId, model, effort, systemFile, settingsFile, maxTurns, maxBudgetUsd,
                            noSessionPersistence, tools }): string[]
```
returns exactly, in this order:
```
-p
--output-format stream-json --verbose --include-hook-events
(--session-id <uuid> | --resume <uuid>)            # --session-id iff first (never reused: R4)
[--model <model>] [--effort <effort>]
--restricted
--setting-sources ""                                # an empty-string argv element
--strict-mcp-config --mcp-config {"mcpServers":{}}
--disable-slash-commands
--append-system-prompt-file <systemFile>            # identical bytes for every message of a context
--settings <settingsFile>                           # content-addressed, per invocation
--permission-mode dontAsk
--max-turns <maxTurns>                              # undisclosed emergency ceiling → class 'ceiling' (documented: cli-reference:106)
[--max-budget-usd <n>]                              # only when configured
[--no-session-persistence]                          # summarizer only
--tools <comma-list>                                # LAST (variadic); '' (empty element) for no tools
```
- Spawn: `spawn(bin, argv, {cwd, env, stdio:['pipe','pipe','pipe'], detached:false})`. Write the message to stdin and `end()`.
- **Never** a positional prompt. Never `--fork-session`, `--bare`, `--safe-mode`, `--fallback-model`, `--add-dir` or `--allowedTools`; the dirs and rules live in `--settings`.

### 10.3 Models (`models.mjs`) — J2-8
```js
export function resolveModel(configured /* '' | 'inherit' | alias | id */, { sessionModel, env = process.env, userSettingsModel }):
  { model: string | null, source: 'config'|'session'|'env'|'user-settings'|'default' }
export async function userSettingsModel(env = process.env): string | null   // `model` in ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json
export function effective(model): string                                    // model ?? '(default)'
```
Chain:
1. The configured value, unless it is empty or `inherit`.
2. `sessionModel` (from `session.json`, kept current by SessionStart and PostModelSwitch).
3. `ANTHROPIC_MODEL`.
4. `model` from `<configDir>/settings.json`.
5. `null`: omit `--model`, so Claude Code uses its default. `--restricted` children ignore user settings, so this choice must be explicit.

Every reply records `init.model`. Every verdict and lineage record stores the resolved model per role.

Escalation and cross-model comparisons use `effective(x) = resolved model string, or '(default)'`.

### 10.4 Forwarded auth settings (`auth-settings.mjs`) — J2-2
```js
export async function forwardedUserSettings({ env = process.env }): object
```
- Read the **user-scope** file `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`.
- Copy only these keys when present: `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`, `forceLoginOrgUUID`.
- Also copy `env` entries whose names pass the child env PASS list (§10.5), for example `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` and `AWS_REGION`.
- Return `{}` when the file is missing.
- The result is merged into every child `--settings` file.
- `cc-rsi doctor --live` proves child auth with one tiny invocation that uses the exact role argv and env.

### 10.5 Child environment (`env.mjs`)
```js
export const PASS: (string|RegExp)[]; export const NEVER: (string|RegExp)[]
export function childEnv({ parentEnv = process.env, role, set = {}, passthrough = [], pluginRoot, home }): object
```
**PASS** (copied if present):
- `HOME USER LOGNAME SHELL PATH LANG LANGUAGE /^LC_/ TERM TZ TMPDIR`
- `HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY`, both cases
- `NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE`
- `/^ANTHROPIC_/`, `CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY`, `/^CLAUDE_CODE_SKIP_.*_AUTH$/`, `CLAUDE_CODE_OAUTH_TOKEN`
- `/^AWS_/`, `GOOGLE_APPLICATION_CREDENTIALS CLOUD_ML_REGION /^VERTEX_REGION_/`
- `CLAUDE_CONFIG_DIR API_TIMEOUT_MS`
- plus `children.envPassthrough` (global-only)

**NEVER** (wins over PASS and passthrough; asserted against a snapshot of this container's env from EXP §f):
- `CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED`
- `/^CLAUDE_CODE_REMOTE/ /INGRESS/ /^CLAUDE_CODE_MESSAGING_/ CLAUDE_CODE_TEE_SDK_STDOUT CLAUDE_CODE_USE_CCR_V2 CLAUDE_CODE_CONTAINER_ID CLAUDE_CODE_ENTRYPOINT`
- `CLAUDE_CODE_ACCOUNT_UUID CLAUDE_CODE_ORGANIZATION_UUID CLAUDE_CODE_USER_EMAIL CLAUDE_PID CLAUDE_CODE_EXECPATH CLAUDE_EFFORT`
- `CLAUDE_CODE_DIAGNOSTICS_FILE CLAUDE_CODE_DEBUG CLAUDE_AUTO_BACKGROUND_TASKS CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH MCP_TOOL_TIMEOUT /^CCR_/ /^CLAUDE_PLUGIN_/ CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE`
- `/^CLAUDE_CODE_SYNC_/ /^CLAUDE_CODE_ARTIFACT/ /^CC_RSI_/` (cc-rsi variables are always set explicitly)

**PATH**: remove entries whose realpath equals `<pluginRoot>/bin` or `<home>/bin` (recursion closure, J2-4).

**SET** (via `set`; callers pass per role):
- `CC_RSI_ROLE`, `CC_RSI_HOME`, `CC_RSI_POLICY`, `CC_RSI_GUARD_LOG`, `CC_RSI_EXPECT`
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `DISABLE_AUTOUPDATER=1`
- `CLAUDE_CODE_RETRY_WATCHDOG=1` and `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS=<transport.watchdogMaxWaitMs>` when `transport.retryWatchdog`
- `DISABLE_AUTO_COMPACT=1` for lossless roles (§10.12)
- Verifier only: `VERIFIER_SCRATCH=<scratch>` and `TMPDIR=<scratch>/tmp`

### 10.6 Settings, policy and the role guard (`settings.mjs`, `policy.mjs`, `hooks/role-guard.mjs`, `lib/guard/*`)

```js
// policy.mjs
export function buildPolicy(spec: RoleSpec): Policy
export async function writePolicy(home, policy): string /* path, content-addressed <home>/run/policies/<sha>.json */
// Policy = {v:1, role, ctxKey, tools:[...], cwd, home, userHome, readRoots:[...], writeRoots:[...], readOnlyRoots:[...], hidden:[...],
//           hiddenTokens:[...], allowedPaths:[cwd, ...addDirs, scratch], bashDeny:[{source, flags, reason}], recursionGuard:true,
//           foreignMessageGuard:true, liveness:boolean, pinFile:string|null, stagnationRevisit:string|null}
// settings.mjs
export function buildSettings(spec: RoleSpec, { pluginRoot, nodePath = process.execPath, forwarded = {} }): object
export async function writeSettings(home, settings): string /* <home>/run/settings/<sha>.json */
export function absRule(tool, absDir): string    // `${tool}(/${absDir}/**)`  → e.g. Edit(//home/u/x/**)
```
Settings shape:
```json
{
  "permissions": {"defaultMode": "dontAsk", "allow": ["…"], "deny": ["…"], "additionalDirectories": ["…"]},
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "<node>", "args": ["<root>/hooks/role-guard.mjs", "prompt"], "timeout": 10, "onFailure": "block"}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "<node>", "args": ["<root>/hooks/role-guard.mjs", "tool"], "timeout": 10, "onFailure": "block"}]}],
    "PostToolUse": [{"matcher": "Bash|Read", "hooks": [{"type": "command", "command": "<node>", "args": ["<root>/hooks/role-guard.mjs", "post"], "timeout": 10}]}],
    "SessionStart": [{"matcher": "compact", "hooks": [{"type": "command", "command": "<node>", "args": ["<root>/hooks/role-guard.mjs", "pin"], "timeout": 10}]}]
  },
  "sandbox": {"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": true,
              "filesystem": {"allowWrite": ["…"], "denyWrite": ["…"], "denyRead": ["…"]}, "network": {"allowedDomains": []}},
  "apiKeyHelper": "… (forwarded only)", "env": {"…": "… (forwarded provider env only)"}
}
```
- `PostToolUse` is present only when `policy.liveness`.
- `SessionStart` is present only when `pinFile` is set.
- `sandbox` is present only in sandbox mode.

Per-role parameters (built by the engine §12.5 and the job §11.5; RoleSpec in §10.9):

| Role | `--tools` | allow | deny (besides `Read(//hidden/**)`) | additionalDirectories | writeRoots (guard) | readOnlyRoots | sandbox allowWrite / denyWrite |
|---|---|---|---|---|---|---|---|
| Verifier (interactive / target, live) | `Read,Grep,Glob,Bash` | `Read Grep Glob Bash` | `Edit Write NotebookEdit WebFetch WebSearch Agent Task Skill` | scratch | — (no file writes) | cwd | `[scratch]` / `[cwd]` |
| Verifier (practice, replay) | same | same | same | scratch (+ `original`) | — | cwd, original | `[scratch]` / `[cwd, original]` |
| Actor (work phase) | `Read,Edit,Write,Glob,Grep,Bash` (+`WebFetch,WebSearch` if `exploration.webTools`) | `Read Grep Glob Bash` + `Edit(//cwd/**)` | `Agent Task Skill NotebookEdit` (+web unless enabled) + `Edit(//memdir/**)` | memdir | cwd | memdir | `[cwd]` / `[memdir]` |
| Actor (learning phase, same session) | same | + `Edit(//memdir/**)` | as work minus `Edit(//memdir/**)` | memdir | cwd, memdir | — | `[cwd, memdir]` / `[]` |
| Curriculum | `Read,Edit,Write,Glob,Grep,Bash` | `Read Grep Glob Bash` + `Edit(//cwd/**)` | `Agent Task Skill NotebookEdit WebFetch WebSearch` + `Edit(//cwd/memory/**)` | — | cwd | `cwd/memory` | `[cwd]` / `[cwd/memory]` |
| Summarizer | `""` | — | — | — | — | — | (no sandbox block) |

Network: Verifier `isolation.verifierNetwork`; Actor `isolation.actorNetwork`; Curriculum `[]`. All default to `[]`.

**`hooks/role-guard.mjs <mode>`**. It reads stdin JSON and `CC_RSI_POLICY`, `CC_RSI_GUARD_LOG` and `CC_RSI_EXPECT`. It appends a guard-log line **before** writing any output. It **never** prints `permissionDecision:"allow"` (F5). On any exception in `tool` mode it prints the deny JSON and exits 0; `onFailure:"block"` covers crashes.

| mode | behaviour |
|---|---|
| `prompt` (UserPromptSubmit) | `d = sha256(payload.prompt)` (R2/F6: byte-identical to stdin). If `d === CC_RSI_EXPECT` or `policy.foreignMessageGuard === false` → log `{hook:'prompt', decision:'pass', digest:d}`, exit 0 with no output. Else → log `{hook:'prompt', decision:'block', digest:d}` and print `{"decision":"block","reason":"cc-rsi: messages from outside the harness are refused"}`. |
| `tool` (PreToolUse `*`) | In order: (1) tool not in `policy.tools` → deny `"<tool> is not available to this role"`. (2) File tools `Read Edit Write MultiEdit NotebookEdit Glob Grep`: paths = `file_path`/`path`/`notebook_path` (Glob/Grep default = cwd), resolved **physically** (`lib/guard/paths.physicalPath`: deepest existing prefix realpath'd plus tail). Deny if under `hidden`; Glob/Grep also deny if a hidden root lies under the search path; deny reads outside `readRoots`; deny write-class tools unless under `writeRoots` and not under `readOnlyRoots`. (3) Bash: `scanBash(command, policy)` → deny with its reason. (4) Else no output. Log `{hook:'tool', toolUseId, tool, decision:'deny'|'pass', reason?}`. |
| `post` (PostToolUse `Bash\|Read`) | Liveness, never blocking. Key = sha256(tool + JSON input); out = sha256(JSON tool_response). State is `<guardLog>.liveness.json`. If key and out equal the previous call's → print `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<repeatWarning>[ + stagnationRevisit (first time only)]"}}`. Errors → exit 0 silently. |
| `pin` (SessionStart `compact`) | Print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<pinFile contents ≤ 9000 chars>}}`. Log `{hook:'pin'}`. |

Deny JSON: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`.

Hidden-path reason (RSIAgent Look guard, `isolation-harness-markers.md` §5): `"<path> is a harness-private path hidden from this role; it is not candidate evidence."`

`lib/guard/bash.mjs`:
```js
export function commandWords(command): { word: string, args: string[] }[]
   // split on newline ; && || | ( ) $( and backticks; skip leading VAR=val, env, sudo, exec, nohup, time, command, nice, timeout N
export function scanBash(command, { hidden = [], hiddenTokens = [], allowedPaths = [], home, userHome, recursionGuard = true,
                                    bashDeny = [] }): string | null
   // returns a deny reason or null. Algorithm:
   //  1. norm = command with '~/', '$HOME/', '${HOME}/' expanded to userHome + '/', and '$CC_RSI_HOME'/'${CC_RSI_HOME}' to home
   //  2. replace every occurrence of each allowedPaths entry (longest first) in norm with a sentinel
   //  3. deny if norm contains any hidden absolute path at a path boundary, or any hiddenTokens entry
   //  4. recursion (below); 5. bashDeny regexes on the original command
   //  - recursion: a command word whose basename is 'claude' or 'cc-rsi'; 'node'/'nodejs' whose first arg matches /cc-rsi|claude-code/;
   //    'npx'/'pnpm'/'bunx'/'yarn' with an arg containing '@anthropic-ai/claude-code'
   //  - any bashDeny regex (Verifier in non-sandbox modes: git push, git remote set-url, curl -X (POST|PUT|PATCH|DELETE)|--data|-d ,
   //    wget --post, ssh , scp , rsync … : , sudo , kill -9 1, docker (rm|stop|kill), kubectl (apply|delete); reason cites the
   //    RSIAgent rule that external services cannot be rolled back)
// lib/guard/paths.mjs
export function physicalPath(p, cwd): string; export function isUnder(child, parent): boolean
export function toolPathArgs(toolName, input, cwd): { paths: string[], search: boolean, write: boolean }
export function searchCoversHidden(searchRoot, hidden): string | null
```

### 10.7 Stream parsing and hook attestation (`stream.mjs`)
```js
export function parseStream(lines: string[]): ParsedStream
// ParsedStream = {
//   init: {sessionId, model, tools:[], mcpServers:[], permissionMode, ccVersion} | null,
//   assistantMessages: [{ id, blocks:[...] }],   // grouped by message.id, in order; only parent_tool_use_id == null
//   finalText: string,                            // concatenated text blocks of the LAST assistant message ('' if none)
//   actions: number,                              // number of tool_use blocks in top-level assistant events
//   toolUses: [{ id, name }], toolResultIds: string[],
//   result: object | null, informational: object[], hookResponses: object[], compacted: boolean, badLines: number }
export function truncated(ps): boolean                // result.stop_reason === 'max_tokens' || last assistant message stop_reason === 'max_tokens'
export function hookAttestation(ps, guardEntries, expectDigest):
  { hooksRan: boolean, promptBlocked: boolean, gaps: string[] /* tool_use ids */ }
```
- `finalText` is the only source of reply text. If `result.result` differs after whitespace normalisation, log a warning and still use `finalText` (F3/F7).
- `hooksRan`: some guard entry `{hook:'prompt', decision:'pass', digest: expectDigest}` exists among the lines appended during this invocation. The runtime records the guard-log size before spawning and reads only the new lines.
- `gaps` (warn only, J2-13) are tool_use ids that satisfy all of the following and have no `{hook:'tool', toolUseId}` entry:
  - the name is in `init.tools`;
  - a tool_result exists for it;
  - the name is not `StructuredOutput`.
- Gaps raise the runtime event `GUARD_GAP`. They never make the outcome infra.

### 10.8 Outcome classification (`classify.mjs`). The first matching row wins.
```js
export function classify({ spawnError, exitCode, signal, killedBy /* 'watchdog'|'stop'|null */, stderr, ps, attestation }):
  { cls: string, infra: boolean, detail: string, reply?: { text, actions, truncated, stopReason, model, costUsdTotal, numTurns,
    permissionDenials } }
```
| # | Observation | `cls` | Handling (in `context.send`) |
|---|---|---|---|
| 1 | `killedBy === 'watchdog'` | `timeout` | InfraError |
| 2 | `killedBy === 'stop'` | `interrupted` | InterruptedError (context stays pending; resumable) |
| 3 | spawn error (ENOENT/EACCES) | `spawn` | InfraError |
| 4 | no `init` and stderr `/sandbox required but unavailable/i` (f2) | `sandbox_unavailable` | degrade policy (§10.9) or InfraError |
| 5 | stderr `/Session ID .* is already in use/i` (R4) | `session_conflict` | InfraError (internal bug; ids are never reused) |
| 6 | `result.errors[]` `/No conversation found/i` (R3) | `session_missing` | InfraError with `{established}`. Callers recover (§10.9) |
| 7 | no events and stderr `/unknown option\|error: /i` | `cli_incompatible` | InfraError ("run cc-rsi doctor") |
| 8 | `init` with `mcpServers.length > 0`, a `tools` entry starting `mcp__`, or `permissionMode !== 'dontAsk'` | `isolation_violation` | InfraError (fail closed) |
| 9 | `attestation.promptBlocked` (our own prompt rejected by the digest filter) | `isolation_violation` | InfraError |
| 10 | `init` and `result` present but `!attestation.hooksRan` | `hooks_not_run` | InfraError (role hooks are disabled, e.g. managed `allowManagedHooksOnly`) |
| 11 | `result.is_error` and (`api_error_status` ∈ {408,409,425,429,500–599,529} or assistant `error` ∈ {overloaded, rate_limit, server_error, timeout, connection}) | `transient` | backoff + recovery note, same session |
| 12 | `result.is_error` and (status ∈ {401,402,403} or error ∈ {authentication_failed, billing_error}) | `auth` | InfraError ("log in again / check apiKeyHelper; run cc-rsi doctor --live") |
| 13 | `result.is_error` and (status 413 or text `/prompt is too long\|context (length\|window)/i`) | `context_overflow` | InfraError |
| 14 | `result.is_error` and (status ∈ {400,404,422} or error `model_not_found`) (F3) | `config` | InfraError (names the model) |
| 15 | `result.subtype === 'error_max_budget_usd'` | `budget` | InfraError |
| 16 | `result.subtype === 'error_max_turns'` | `ceiling` | InfraError |
| 17 | `result.stop_reason === 'refusal'` or `safety_stops > 0` | `refusal` | InfraError (never a verdict) |
| 18 | `result.is_error` or `subtype` starts with `error_` | `error` | InfraError |
| 19 | exit ≠ 0 and no `result` | `crash` | InfraError (stderr tail kept) |
| 20 | exit 0 and no `result` | `protocol` | InfraError |
| 21 | `result.num_turns === 0` or no assistant message (F7) | `no_reply` | InfraError; `result.result` is **never** parsed |
| 22 | otherwise | `reply` | return the reply built from `finalText` |

`permission_denials` are agent-visible tool errors, not infra; their count is recorded.

### 10.9 Role contexts (`context.mjs`) — the seam shared by the job (§11.5) and the engine (§12)

```js
// RoleSpec (plain object; every path absolute)
// { key, role: 'actor'|'verifier'|'curriculum'|'summarizer', phase: 'work'|'learn'|null,
//   cwd, addDirs: [], tools: [], allow: [], deny: [], readRoots: [], writeRoots: [], readOnlyRoots: [], hidden: [], hiddenTokens: [],
//   bashDeny: [], sandbox: null | { allowWrite: [], denyWrite: [], denyRead: [], network: [] },
//   sandboxDegrade: 'allow' | 'refuse',
//   systemText: string,                    // rendered system append; written content-addressed to <home>/run/prompts/<sha>.md
//   model: string|null, effort: string|null,
//   lossless: boolean, pinText: string|null, liveness: boolean, stagnationRevisit: string|null,
//   maxTurns, turnTimeoutSec, pauseCeilingSecs, watchdogMaxWaitMs, maxBudgetUsd: number|null,
//   noSessionPersistence: boolean, extraEnv: {}, logDir, home, pluginRoot, config }
export class RoleContext {
  constructor(spec, { sessionId, logger, onRuntimeEvent = () => {}, signal, onDegrade })
  get sessionId(): string
  setSpec(spec): void                        // e.g. the Actor's work → learn policy switch (same session)
  async send(message, { recovering = false } = {}): Reply
}
// Reply = { text, actions, truncated, stopReason, model, costUsdTotal, costUsdDelta, sessionId, invocation, numTurns,
//           permissionDenials, guardGaps, durationMs }
export function recoveryNoteFor(message): string     // = prompts.recoveryNote({message})
```
**Session registry**: `<logDir>/sessions/<sessionId>.json` = `{attempted, completed, lastCostUsdTotal}`. It is written atomically **before** each spawn.

**Invocation logs**: `<logDir>/<n>/` holds:
- `prompt.md`: the exact stdin bytes;
- `stream.jsonl`;
- `stderr.txt`: the last 64 KiB;
- `guard.jsonl`, which is `CC_RSI_GUARD_LOG`;
- `meta.json` = `{n, sessionId, mode:'new'|'resume', argv, settingsFile, policyFile, systemFile, cwd, startedAt, finishedAt, exitCode, signal, cls, detail, actions, numTurns, costUsdTotal, model, guardGaps, permissionDenials, truncated}`.

`n` is monotonic per `logDir`.

`send(message, {recovering})`:
1. `reg` ← the session registry. `text` ← `recovering && reg.attempted > 0 ? recoveryNote(message) : message`. `spent` ← 0. `k` ← 0.
2. `first` ← `reg.attempted === 0`. Write `reg.attempted++`. Render the policy (with `CC_RSI_EXPECT = sha256(text)`), the settings and the system file. Spawn with `buildArgv({first, …})`. Enforce the watchdog `turnTimeoutSec` with `killGracefully` (SIGINT → 10 s → SIGTERM → 10 s → SIGKILL), plus the abort `signal` (`killedBy:'stop'`).
3. Classify (§10.8) and act on the class:

   | Class | Action |
   |---|---|
   | `reply` | `reg.completed++`, record cost and return. |
   | `transient` | If `spent ≥ pauseCeilingSecs` → InfraError(`transient_exhausted`). Otherwise wait `min(pauseSecs·2^k, pauseMaxSecs)` (abortable), emit runtime event `TRANSPORT_PAUSE{secs, cls, status}`, set `text ← recoveryNote(message)`, `k++`, and go to 2. Pause time is not charged to any watchdog. |
   | `sandbox_unavailable` | If `spec.sandboxDegrade==='allow'`: emit `ISOLATION_DEGRADED{reason}`, record `probe.json.live = {available:false, reason}`, roll back `reg.attempted` (no session was created), ask `onDegrade(first)` for a new spec (no sandbox; re-rendered mechanics if `first`, else a prefix note `"HARNESS NOTE: the OS sandbox is unavailable from now on; your shell commands are NOT sandboxed …"`), and go to 2. Otherwise → InfraError. |
   | `session_missing` | InfraError(`session_missing`, `{established: reg.completed > 0}`). |
   | `interrupted` | InterruptedError. |
   | any other | InfraError(cls, detail). |

R3/R4 recovery belongs to the caller:
- A context that was never established (`established:false`) restarts with a **new uuid** and the original message, because R4 forbids reusing the id. This is event `ROLE_CONTEXT_RESTARTED`.
- An established context whose transcript is gone (e.g. pruned after `cleanupPeriodDays`):
  - Verifier → a fresh context seeded with its prior reports;
  - Actor and Curriculum → InfraError(`context_lost`), and the lineage pauses.

### 10.10 Same-context continuation (`converse.mjs`)
```js
export async function converse({ first, send /* (message, index) → Reply */, parse /* (reply, index) → Parsed */, continuation /* detail → string */,
                                 truncatedContinuation, stallContinuation, policy: { actionlessLimit = 3, ceiling = 24 }, who,
                                 overrideFor = () => false /* (livenessKey) → boolean */ }): { value, reply, index }
```
```
index = 1; reply = send(first, 1); actionless = 0; rounds = 0
loop:
  rounds++
  p = parse(reply, index); if p.ok → return {value: p.value, reply, index}        // a valid publication wins even when actionless
  if reply.truncated → reply = send(truncatedContinuation(), ++index); continue   // output-limit turn end: not counted
  actionless = reply.actions === 0 ? actionless + 1 : 0
  if actionless ≥ policy.actionlessLimit or rounds ≥ policy.ceiling:
     key = `liveness@${index}`
     if overrideFor(key): actionless = 0; rounds = 0; reply = send(stallContinuation(), ++index); continue
     throw new TransportInfraError(actionless ≥ limit ? 'transport_liveness' : 'transport_ceiling',
                                   `${who}: …(${p.detail})`, { livenessKey: key })
  reply = send(continuation(p.detail), ++index)                                    // SAME context (--resume)
```
`errors.mjs`:
```js
export class InfraError extends Error { constructor(cls, detail, extra = {}) }            // .cls .detail .extra
export class TransportInfraError extends InfraError {}                                    // cls transport_liveness | transport_ceiling
export class InterruptedError extends Error {}
export const BRANCH_RETRYABLE = new Set(['crash','protocol','no_reply','error','timeout','context_lost'])
```

### 10.11 Sandbox (`sandbox.mjs`)
```js
export function staticProbe({ platform = process.platform, env = process.env } = {}):
  { available: boolean, reason: string, details: { bwrap: string|null, socat: string|null, sandboxExec: boolean, wsl1: boolean } }
   // linux: bwrap AND socat on PATH (fs lookup, no spawn); WSL1 (/proc/version 'Microsoft' without 'WSL2') → unavailable;
   // darwin: /usr/bin/sandbox-exec exists; others → unavailable
export async function readProbe(home); export async function writeProbe(home, probe)
export function effectiveProbe(probeFile, staticResult): { available, reason }   // a live failure recorded for the same static details wins
export function decideIsolation({ want /* 'auto'|'require'|'off' */, probe }): { sandbox: boolean, refuse: boolean, reason: string }
export async function liveProbe({ bin, home, env, model }): { available: boolean, reason: string, enforced: boolean | null }
   // child with sandbox {enabled, failIfUnavailable, allowUnsandboxedCommands:false, filesystem.allowWrite:[tmp]}: exit 1 +
   // 'sandbox required but unavailable' → unavailable (no model call, f2); else ask the model to `touch <outside>/probe`
   // via Bash and check the file is absent → enforced
```
Record vocabulary:
- Interactive Verifier: `isolation.mode` is `sandbox` | `rollback`. Rollback always restores the checkpoint.
- Lineages: `sandbox` | `unconfined`.

The Verifier's mechanics paragraph is rendered from the **actual** mode, so nothing claims an isolation that is not there.

### 10.12 Per-role compaction and ceilings (RSIAgent role configs; PF §5.7)

| Role context | Compaction | `--max-turns` (per invocation) | Watchdog `turnTimeoutSec` | Pause ceiling |
|---|---|---|---|---|
| practice Actor, Curriculum, every Verifier | **off**: `DISABLE_AUTO_COMPACT=1`. Overflow → `context_overflow` infra (RSIAgent `history_keep_pairs: 0`) | 2000 | 14400 (Verifier interactive: 7200) | lineage 21600 s, interactive 1800 s |
| target/frozen Actor | Claude Code auto-compaction **on**, plus the role SessionStart(`compact`) hook re-pinning `taskPin` + `memoryRevisit('fold')` (RSIAgent fold task pin) | 2000 | 14400 | 21600 s |
| summarizer | n/a (`--no-session-persistence`, `--tools ""`) | 1 | 600 | 600 s |

All values are configurable (§14). An interactive Verifier `context_overflow` marks the task's Verifier context as retired, so the next `submit` opens a fresh context seeded with prior reports.

### 10.13 Worked child invocations (normative examples; `H` = `<home>`, `W` = lineage work tree, `$U` = the user's HOME)

Rule notation: `Tool(//X/**)` means `absRule(tool, X)` applied to the absolute path X, i.e. the string `Tool(/` + X + `/**)`, which yields `Tool(//abs/x/**)` because X starts with `/`.

**Interactive Verifier, first inspection of task 3** (cwd = candidate root `/repo`):
```
claude -p --output-format stream-json --verbose --include-hook-events --session-id 6f1c…e2 [--model opus]
  --restricted --setting-sources "" --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands
  --append-system-prompt-file H/run/prompts/<sha>.md --settings H/run/settings/<sha>.json --permission-mode dontAsk
  --max-turns 2000 --tools Read,Grep,Glob,Bash
stdin: verifierCharter(...) (generation 1)
env:   <PASS allowlist> CC_RSI_ROLE=verifier CC_RSI_HOME=H CC_RSI_POLICY=H/run/policies/<sha>.json
       CC_RSI_GUARD_LOG=<P>/sessions/<sid>/ctx/task-3-v1/1/guard.jsonl CC_RSI_EXPECT=<sha256(stdin)>
       VERIFIER_SCRATCH=H/vscratch/6f1c…e2 TMPDIR=H/vscratch/6f1c…e2/tmp CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
       CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 DISABLE_AUTOUPDATER=1
       DISABLE_AUTO_COMPACT=1 CLAUDE_CODE_RETRY_WATCHDOG=1 CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS=1800000
settings.permissions: allow [Read, Grep, Glob, Bash]; deny [Edit, Write, NotebookEdit, WebFetch, WebSearch, Agent, Task, Skill,
       Read(//H/projects/**), Read(//H/run/**), Read(//H/bin/**), Read(//$U/.claude/projects/**), Read(//H/vscratch/<other>/**) …];
       additionalDirectories [H/vscratch/6f1c…e2]
```
The re-verification after FAIL is identical except for `--resume 6f1c…e2`, a new stdin (the generation-2 charter) and a new invocation dir `…/task-3-v1/2/`.

**Phase-1 practice Actor, first message** (cwd = `W/projects/w001-csv-merge`):
```
claude -p … --session-id <uuid> [--model <actor>] … --append-system-prompt-file H/run/prompts/<engineSystem sha>.md
  --settings H/run/settings/<sha>.json --permission-mode dontAsk --max-turns 2000 --tools Read,Edit,Write,Glob,Grep,Bash
stdin: practiceActorCharter(...) + actorRuntimeContract(...)
env:   … CC_RSI_ROLE=actor DISABLE_AUTO_COMPACT=1 (practice Actor is lossless) …
settings.permissions: allow [Read, Grep, Glob, Bash, Edit(//W/projects/w001-csv-merge/**)];
       deny [Agent, Task, Skill, NotebookEdit, WebFetch, WebSearch, Edit(//W/actor-private/w001-csv-merge/memory/**),
             Read(//W/curriculum-private/**), Read(//W/verify/**), Read(//W/verify-scratch/**), …];
       additionalDirectories [W/actor-private/w001-csv-merge/memory]
```
The learning messages of the same context use `--resume <uuid>`. The settings then allow `Edit(//W/actor-private/w001-csv-merge/memory/**)` and drop that deny.

**Target Verifier** (cwd = live root `W/projects/t001`, scratch `W/verify-scratch/t001-v1`): Verifier flags as above. `DISABLE_AUTO_COMPACT=1`. Hidden includes `W/actor-private` (the Actor's memory was also deleted before the inspection).

**Curriculum** (cwd = `W/curriculum-private`): `--tools Read,Edit,Write,Glob,Grep,Bash`, allow `Edit(//W/curriculum-private/**)`, deny `Edit(//W/curriculum-private/memory/**)`, system = `engineSystem` + `curriculumSystem`.

**Summarizer**: `--session-id <fresh uuid> --no-session-persistence --max-turns 1 --tools ""`, cwd `W/summarizer`, system `summarizerSystem` (or `strategyReviewSystem`). stdin = the request.

---

## 11. Interactive everyday mode: Actor = main session (WP5)

### 11.1 Session state (`lib/interactive/session.mjs`)
```js
export async function sessionContext({ payload, env = process.env }): { home, sid, projectDir, projectRoot, key, pl, sl, session }
   // projectDir = env.CLAUDE_PROJECT_DIR || payload.cwd; projectRoot/key cached in <home>/run/sessions/<sid>.json
   // ({projectKey, projectRoot}) after the first computation; creates dirs on demand
export async function writeSession(sl, patch): session      // atomic merge into session.json
export async function readSessionByEnv(env): session | null  // MCP fallback for status: env.CLAUDE_CODE_SESSION_ID
```
`session.json` holds:
```json
{"v": 1, "sessionId": "…", "transcriptPath": "…", "cwd": "…", "projectDir": "…", "projectRoot": "…", "projectKey": "…",
 "model": "claude-opus-5" | null, "modelSource": "session-start" | "model-switch" | null, "source": "startup|resume|clear|compact|fork",
 "pluginRoot": "/abs", "startedAt": "…", "lastSeen": "…", "endedAt": null, "pendingBaselineSeq": 12 | null}
```

### 11.2 Task state machine (`lib/interactive/task.mjs`; `task.json` under the session LeaseLock, held ≤ 5 s by hooks)

```json
{"v": 1, "sessionId": "…", "taskSeq": 3,
 "task": {"seq": 3, "firstRequestSeq": 12, "openedAt": "…", "openDigest": "…" | null, "baselineFile": "/abs" | null,
          "candidateRoot": "/abs" | null,
          "verifier": {"ctxIndex": 1, "ctxKey": "task-3-v1", "sessionId": "uuid" | null, "model": "…" | null,
                       "lastUsed": "…" | null, "retired": false},
          "generation": 2,
          "reports": [{"gen": 1, "jobId": "j-…", "verdict": "FAIL", "reportSha": "…", "statusDigest": "…" | null,
                       "candidateDigest": "…", "isolation": "rollback", "model": "…", "at": "…"}],
          "lastVerdict": "PASS" | "FAIL" | "UNVERIFIED" | null, "lastVerdictGen": 1, "lastVerdictRequestSeq": 14,
          "learned": false, "closed": false},
 "prevTask": null,
 "job": {"id": "j-…", "pid": 123, "gen": 2, "startedAt": "…"} | null,
 "learning": {"episode": "task-1a2b3c4d-3-g2", "taskSeq": 3, "gen": 2, "verdict": "PASS", "reportSha": "…",
              "stage": "distill" | "reconcile", "code": "7f3a9c", "draftDir": "/abs", "openedAt": "…"} | null,
 "stop": {"nudged": ["changes:<digest>", "learn:3-g2", "wait:j-…"], "gate": {"promptId": "…", "blocks": 1}},
 "lastDeliveredJob": "j-…" | null}
```
```js
export async function withTask(sl, fn /* (state) → state|void */, { waitMs = 5000 } = {}): state   // lock, read, fn, atomic write
export function emptyState(sid): state
export function openTask(state, { requestSeq, openDigest, baselineFile }): state   // moves an unlearned terminal task to prevTask
export function learnTarget(state): { which: 'task'|'prevTask', t } | null       // terminal (PASS|FAIL) and !learned
```
Transitions:

| Event (actor) | Guard | Effect |
|---|---|---|
| UserPromptSubmit (hook) | not synthetic; `learning == null`; `job == null`; and (`task == null`, or `task.closed`, or `task.lastVerdict === 'PASS'`) | `openTask` (`taskSeq++`, `firstRequestSeq = seq`, `openDigest = statusDigest(projectRoot)` (3 s cap; null on failure), `baselineFile` = spawned S0 baseline). If the old task has an unlearned PASS/FAIL it becomes `prevTask`; otherwise `prevTask = null` |
| `submit` | `job != null` | behave like `wait_verdict` |
| `submit` | `learning != null` | refuse `learning_open` |
| `submit` | `task == null`, or `task.closed`, or `candidateRoot` ≠ `task.candidateRoot` (when set) | `openTask` first (covers sessions whose UPS hook did not run) |
| `submit` (accepted) | — | set `task.candidateRoot`; `generation++`; pick the Verifier context (§11.5 step 0); create the job; `job = {…}` |
| job result: verdict | the target is the task with `seq === job.taskSeq` (`task`, or else `prevTask`; if neither matches, only `verdicts.jsonl` is written) | push the report; set `lastVerdict`, `lastVerdictGen`, `lastVerdictRequestSeq = current request count`, `learned = false`; set `verifier.sessionId`/`lastUsed`; `job = null` |
| job result: infra | — | `job = null`, no verdict; `verifier.retired = cls ∈ {context_overflow, session_missing(established)}` |
| `learn` | `learnTarget` exists; mode learn; not frozen, sealed or tampered; statusDigest unchanged (§11.3); episode not committed or quarantined | `openDraft(episode, {dir: <P>/drafts/<safe(episode)>, owner:{kind:'session', sessionId}})`; `learning = {stage:'distill', code}` |
| `memory_commit` | `learning != null`; `confirm === learning.code` | `distill` → `reconcile` (new code). `reconcile` → `store.commit(kind 'task')`: on success the target's `learned = true` and, if the target is `task`, `task.closed = true`; `learning = null` |
| `memory_commit({abandon:true})` | `confirm === learning.code` | `discardDraft`; the target's `learned = true` (skipped); `learning = null` |

**Confirm codes** (PR §4.4). Each stage message carries a fresh 6-hex code, and the next `memory_commit` must present it. The Actor can only present the code after reading the stage instructions. This replaces dsh's same-step check and needs no transcript parsing.

### 11.3 Verdict staleness (J2-7)
- Every report records `statusDigest`, computed by `statusDigest(candidateRoot)` before the checkpoint.
- A verdict is **current** iff the current `statusDigest(candidateRoot)` equals it. In a non-git project both values are `null` and the check is skipped, with that stated in `status`.
- `status`, Stop and `learn` use only current verdicts:
  - `status` prints `PASS (stale: the workspace changed since the inspection)`;
  - `learn` refuses a stale verdict with `stale_verdict` ("submit again so a verdict covers the current candidate");
  - Stop treats a stale PASS as "no verdict covers the current state".

### 11.4 MCP caller attestation (`lib/interactive/attest.mjs`; J1-1)
```js
export async function writeAttestation(attDir, { tool_use_id, tool_name, session_id, transcript_path, cwd, agent_id, agent_type,
                                                  permission_mode, prompt_id }): void   // <attDir>/<tool_use_id>.json 0600, atomic
export async function takeAttestation(attDir, toolUseId, { waitMs = 2000, pollMs = 25 } = {}): object | null   // read + unlink
export async function sweepAttestations(attDir, { olderThanMs = 3600000 } = {}): number
```
1. The PreToolUse hook `attest` (matcher `^mcp__plugin_cc-rsi_rsi__`) writes the record. If `CC_RSI_ROLE` is set, it denies instead (children never load the plugin [V R5]; this is defence in depth).
2. The server reads `params._meta["claudecode/toolUseId"]` [V E9] and takes the attestation, polling for up to 2 s.
3. State-changing tools (`submit`, `wait_verdict`, `learn`, `memory_commit`) without an attestation → `isError` `not_attested`: "cc-rsi cannot attest this call: its hooks are not active in this session (run cc-rsi doctor). No verification was started."
4. An attestation with `agent_id` (a subagent of the main session) → `isError` `subagent`: "submit/learn are reserved for the main Actor conversation."
5. `status` falls back to `CLAUDE_CODE_SESSION_ID` when unattested.

### 11.5 The verification job (`lib/interactive/verify-job.mjs`)

**Job file** `<sl.jobs>/<jobId>.json`. The server creates it with status `queued`; afterwards only the job writes it.
```json
{"v": 1, "id": "j-…", "status": "queued" | "running" | "done" | "infra", "sessionId": "…", "projectKey": "…", "taskSeq": 3,
 "generation": 2, "candidateRoot": "/abs", "pluginRoot": "/abs", "home": "/abs",
 "verifier": {"ctxKey": "task-3-v1", "sessionId": "uuid", "fresh": true, "model": "sonnet" | null, "modelSource": "config"},
 "taskMessages": [{"seq": 12, "text": "…", "current": true}],
 "leadsText": "LEAD 1 …" | null, "leadsIgnored": false,
 "priorReportShas": ["…"], "baselineFile": "/abs" | null, "prevManifest": "/abs" | null,
 "config": {"…": "effective config snapshot"}, "isolationWant": "auto",
 "createdAt": "…", "startedAt": "…" | null, "pid": 123 | null, "heartbeatAt": "…" | null,
 "checkpoint": {"dir": "/abs", "open": true, "detectOnly": false} | null,
 "result": {"verdict": "FAIL", "reportSha": "…", "restored": ["…"], "displaced": ["…"], "detectOnly": false,
            "isolation": {"mode": "rollback", "reason": "sandbox unavailable: bubblewrap (bwrap) not installed"},
            "model": "claude-…", "costUsd": 0.12, "statusDigest": "…" | null, "candidateDigest": "…",
            "invocations": 3, "guardGaps": 0, "finishedAt": "…"} | null,
 "infra": {"cls": "transient_exhausted", "detail": "…"} | null,
 "delivered": false}
```

**Server side of `submit`** (`lib/mcp/tools.mjs`):
1. Attest (§11.4) and load `sessionContext`. Load the config: `loadConfig` with `userConfigFromEnv(env, 'CC_RSI_OPT_')`. Open the store (frozen/sealed flags; tamper → a warning note in the result).
2. Under `withTask` (held only for the state transition, never during the wait), apply the transitions of §11.2. **Step 0, pick the Verifier context:**
   - Reuse `task.verifier` iff `sessionId` is set, it is not `retired`, the resolved model is unchanged, and `lastUsed` is within `interactive.verifierIdleHours` (24 h).
   - Otherwise `ctxIndex++`, a new uuid, `fresh = true`, and `priorReportShas = task.reports.map(r => r.reportSha)`.
3. Leads: `validateLeadArgs(evidence_leads)` only when `task.lastVerdict === 'UNVERIFIED'`; otherwise `leadsIgnored = true` and a result note.
4. `taskMessages` = `taskMessagesFor(requests, task.firstRequestSeq, interactive.taskMessages)` (§11.8). Write the job file. `spawnDetached(process.execPath, [<pluginRoot>/lib/interactive/verify-job.mjs, 'run', jobFile], {logFile: <job>.log})`, then `task.job.pid = pid`.
5. Wait for `status ∈ {done, infra}` for up to `waitSeconds(config)` (§11.11), sending progress every 5 s. Then:
   - done → `deliver(job)`: mark `delivered` and `lastDeliveredJob`, return `guidanceVerdict(…)`;
   - infra → `guidanceInfra`;
   - timeout → `guidanceRunning`.

**Job side** (`verify-job.mjs run <jobFile>`). The job refuses when `CC_RSI_ROLE` is set. Steps:
1. Write `status=running`, `pid`, `startedAt`, and start the heartbeat (job file `heartbeatAt` every 5 s).
2. **Workspace lock** (§11.6) for `candidateRoot`. If it is held by another live job → infra `workspace_busy`.
3. `statusDigest(candidateRoot)` → `sd`.
4. `Checkpoint.take(candidateRoot, {dir: <sl.checkpoints>/<jobId>, caps})`, then `checkpoint={dir, open:true, detectOnly}`. A failure → infra `checkpoint_failed`, and nothing else runs.
5. **Mechanical context**, in this order: `workspaceFacts(candidateRoot)`; the `baselineDelta` (when `baselineFile` holds a complete baseline); `CHANGED SINCE YOUR LAST INSPECTION` = `contentDelta(prevManifest, checkpoint.manifest())` when `prevManifest` exists. Write `<sl.manifests>/t<NNN>-g<NNN>.json` = `checkpoint.manifest()`.
6. **Isolation**: `decideIsolation({want: config.isolation.sandbox, probe})`. `refuse` → infra `sandbox_required`. Mode = `sandbox` or `rollback`.
7. **Verifier context**: `new RoleContext(spec, {sessionId})`. The spec:
   - `role:'verifier'`, `cwd: candidateRoot`, `addDirs: [<home>/vscratch/<sessionId>]` (created with `tmp/`);
   - `tools: Read,Grep,Glob,Bash`;
   - hidden per §4.3, plus every other `<home>/vscratch/*`;
   - `systemText: verifierSystem({location:'live', sandbox, allowUnverified: config.interactive.allowUnverified})`;
   - `lossless: true`, `liveness: false`;
   - `bashDeny`: the mutation patterns when not sandboxed;
   - `maxTurns 2000`, `turnTimeoutSec 7200`, `pauseCeilingSecs 1800`, `watchdogMaxWaitMs 1800000`;
   - `logDir: <sl.ctx>/<safe(ctxKey)>`;
   - `sandboxDegrade: 'allow'` (interactive degrades explicitly to rollback).

   The charter is `verifierCharter({generation, task: interactiveTask({messages}), candidateRoot, scratchDir, mechanical, changedSinceLast, leads: leadsText, priorReports: fresh ? texts of priorReportShas (missing → '(report unavailable)') : [], handover: fresh && priorReports.length ? 'self' : null})`.
8. `converse({first: charter, send: ctx.send, parse: r => parseVerdict(r.text, {allowUnverified}), continuation: d => verifierContinuation({detail:d, allowUnverified}), …, policy: transport})`.
   - `session_missing` with `established:true` → open a fresh context (new uuid, `ROLE_CONTEXT_RESTARTED`) seeded with prior reports, once.
   - `established:false` → new uuid with the same charter, once.
9. **Restore**, always, also after infra: `checkpoint.restore({displacedDir: <sl.displaced>/<jobId>})`. If `failed.length` → infra `restore_failed`, and the **lock is kept** with `restoreFailed:true` (fail closed; `cc-rsi doctor --release-lock <root>` is human-only). Otherwise `checkpoint.dispose()` and `checkpoint.open=false`.
10. **Record**:
    - `store.putReport(report)`;
    - job `result` (with `statusDigest: sd`, `candidateDigest: checkpoint.fingerprint()`);
    - `withTask` verdict transition;
    - append `<sl.verdicts>`: `{ts, taskSeq, generation, jobId, verdict, reportSha, isolation, model, costUsd, statusDigest, candidateDigest, restored: n}`;
    - `status=done` (or `infra` with `{cls, detail}`).
11. Release the workspace lock and stop the heartbeat.

**Recovery** (`verify-job.mjs recover <jobFile>`). SessionStart, `submit`, `wait_verdict` and `status` spawn it for any job with status `running` whose `pid` is dead and whose heartbeat is older than 30 s. It:
- restores an open checkpoint (displaced copies kept);
- writes infra `job_died` ("verification did not complete; the candidate was restored; this is not a verdict");
- clears `task.job`;
- releases the lock (unless the restore failed).

Unattended recovery never runs while the job pid is alive.

### 11.6 Workspace lock (`lib/interactive/wslock.mjs`)
```js
export async function acquireWorkspaceLock(locksDir, root, { jobId, sessionId }): LeaseLock   // file <locksDir>/<sha256(root).slice(0,24)>.json
export function listLocksSync(locksDir): [{ root, jobId, sessionId, pid, host, at, restoreFailed, live: boolean }]
export function lockCovering(locks, absPath): lock | null         // path inside lock.root (lexical, both realpath'd when possible)
export async function markRestoreFailed(locksDir, root)            // rewrites the payload with restoreFailed:true and stops heartbeats
```
- The payload is LeaseLock's `owner` = `{root, jobId, sessionId, restoreFailed:false}`.
- The guard treats a lock as live iff it is `restoreFailed`, or its mtime is within 30 s, or (same host and the pid is alive).
- The lock is project-wide: it blocks every session and subagent working under the root.

### 11.7 `hooks/hooks.json` (exact content)
```json
{
  "description": "cc-rsi: RSI protocol for the main (Actor) session — protocol context, verbatim request capture, private-path guard, verification lock, MCP attestation, verdict wake-up, stop policy",
  "hooks": {
    "SessionStart": [{"matcher": "startup|resume|clear|compact|fork", "hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "session-start"], "timeout": 20}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "prompt"], "timeout": 15}]}],
    "PreToolUse": [
      {"matcher": "Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell|Monitor", "hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "guard"], "timeout": 10}]},
      {"matcher": "^mcp__plugin_cc-rsi_rsi__", "hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "attest"], "timeout": 10}]}
    ],
    "PostToolUse": [{"matcher": "^mcp__plugin_cc-rsi_rsi__(submit|wait_verdict)$", "hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "rewake"], "timeout": 7200, "asyncRewake": true}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "stop"], "timeout": 15}]}],
    "PostModelSwitch": [{"hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "model"], "timeout": 10}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", "session-end"], "timeout": 1}]}]
  }
}
```
- The first PreToolUse matcher is an exact list (`[A-Za-z0-9_\- ,|]` only).
- The MCP matchers are anchored regexes (`_`/`-` are list-safe, but `^` forces the regex path).
- No `onFailure` key: main-session hooks continue on failure (fail open).

### 11.8 Hook behaviour (`hooks/hook.mjs <sub>` → `lib/hooks/<sub>.mjs`)

Common rules (`lib/hooks/common.mjs`):
- If `CC_RSI_ROLE` is set → exit 0 silently. Exception: `attest` denies.
- Read stdin JSON. On a parse failure → exit 0.
- Wrap everything in try/catch: log to `<home>/logs/hooks.log` and exit 0 with no output (fail open).
- Emit at most one JSON object on stdout.
- A hook never spawns `claude`.
- Measured budget: p95 < 150 ms for `guard`/`attest`, < 400 ms for `session-start`/`prompt` (excluding the 3 s git cap).

| Sub | Behaviour |
|---|---|
| `session-start` | (1) `sessionContext`, then `writeSession({…, source, model: payload.model ?? previous, modelSource})`, index `<home>/run/sessions/<sid>.json`. (2) `writeShim(home, CLAUDE_PLUGIN_ROOT)` (§13.2). (3) `MemoryStore.open` (recovery). Tamper check: warning only. (4) `refreshView` (§11.10). (5) Spawn `verify-job.mjs recover` for dead running jobs of this session. (6) stdout `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": C}, "systemMessage": M}`. **C** (≤ 9000 chars) = `actorProtocol({mode, allowUnverified, memoryViewDir})` + `memoryPreamble({memoryDir: viewDir, inventory})` + notices (paused or running lineages of the project, tamper warning, frozen/sealed). On `compact`, C also gets `taskPin(current task messages)` + `memoryRevisit('fold')` (when memory is non-empty). **M** (user-visible; only on `startup`/`resume`/`clear`/`fork`) = `cc-rsi: Verifier isolation = <sandbox\|rollback> (<reason>); Verifier model = <resolved\|inherit>; memory <N> files (<mode>)` + `; WARNING: Verifier model equals the session model` when equal + `; WARNING: memory changed outside a commit (cc-rsi memory verify)` on tamper. |
| `prompt` | (1) Synthetic prompts are skipped: those starting with `<task-notification>`, `<cross-session-message`, `<scheduled-task`, `<local-command-`, `<command-name>` or `<command-message>`, and those matching `^/[A-Za-z0-9_:.-]+(\s\|$)` (slash commands and skills). (2) Append to `requests.jsonl`: `{seq, ts, promptId, text}` (seq = previous max + 1). (3) `withTask`: open a task per §11.2. When it opens one: if `interactive.baseline` and the project is a git repo, spawn `node lib/workspace/baseline.mjs <root> <sl.baselines>/b-<seq>.json <openedAt>` detached and set `task.baselineFile`. (4) `refreshView` if canonical changed. (5) stdout additionalContext only when (a) the memory inventory changed since SessionStart (a new preamble), or (b) a job is running: `"An independent cc-rsi verification is running (job …). File edits and shell commands are paused; call wait_verdict to receive the verdict."` |
| `guard` | Applies to the main thread **and** its subagents (`agent_id` present). Loads `session.json` and the task (read-only, no lock) plus `listLocksSync`. **Private roots**: `<home>`, except allowed paths = `viewDir` (read), `<home>/bin` (read/exec), and `learning.draftDir` (read + write while learning is open). Rules in order: (1) **Lock**: if a live lock covers `payload.cwd` or any write-tool path → deny Edit/Write/MultiEdit/NotebookEdit/Bash/PowerShell/Monitor: `"cc-rsi: an independent verification of this workspace is running (job <id>, started <hh:mm:ss>). File changes and shell commands are paused until it finishes. Call the cc-rsi wait_verdict tool."` (restoreFailed → `"… a verification failed to restore the workspace; run cc-rsi doctor in a terminal"`). Read/Grep/Glob stay allowed. (2) **File tools**: physical path under `<home>` and not allowed → deny `"<path> is cc-rsi private state; it is not part of your task."`. Grep/Glob whose search root covers `<home>` → deny (`"narrow the search path; it covers cc-rsi private state"`). Paths under `~/.claude/projects/` whose basename starts with a role session id listed in `task.verifier.sessionId` / `prevTask.verifier.sessionId` → deny. Read/Grep/Glob under `viewDir` or the draft → **allow** (`permissionDecision:"allow"`, suppresses prompts outside cwd [U]). Edit/Write/MultiEdit under the draft while learning → allow. Edit/Write under `viewDir` → deny `"the memory view is read-only; durable memory changes only through learn → memory_commit"`. Edit/Write of `<projectRoot>/.claude/cc-rsi.json` while a job runs → deny. (3) **Bash**: `scanBash(command, {hidden:[<home>], allowedPaths:[viewDir, <home>/bin, draftDir?], home, userHome, recursionGuard:false})` → deny reason. **Human-only** regexes → deny `"cc-rsi: that command is human-only; ask the user to run it in a terminal"`: `/\bcc-rsi\b[^\n;&|]*\b(eval|unfreeze|restore|import|accept-external|prune|abandon|release-lock|cancel)\b/`; also `/\bcc-rsi\b[^\n;&|]*\bexplore\s+(start\|resume)\b/` unless `exploration.modelMayStart`. Role session id literals → deny. (4) Otherwise exit 0 with no output. |
| `attest` | `writeAttestation(…)`; no stdout. Under `CC_RSI_ROLE` → deny `"cc-rsi tools are not available inside role contexts"`. |
| `rewake` | (asyncRewake [U]) Only when `interactive.rewake` (default true) and `JSON.stringify(payload.tool_response)` contains `VERIFICATION RUNNING (job <id>`. Poll `<sl.jobs>/<id>.json` every 2 s until `done`/`infra`, or until 7100 s. If `delivered` is already true → exit 0. Else exit **2** with stderr `"cc-rsi: the independent verification (job <id>) finished — VERDICT: <V> (generation <g>). Call wait_verdict to receive the report and guidance."` (infra: `"… finished without a verdict (infrastructure). Call wait_verdict for details."`). |
| `stop` | §11.9 |
| `model` | `writeSession({model: payload.to_model, modelSource:'model-switch'})`. |
| `session-end` | `writeSession({endedAt})` with a ~1 s budget. Never touches jobs. |

**Task messages for the Verifier** (`requests.mjs`):
```js
export function taskMessagesFor(requests, firstRequestSeq, n): [{ seq, text, current }]
   // the last n requests with seq ≥ firstRequestSeq (current:true); if fewer than n exist, fill up to n with the preceding
   // requests (current:false, rendered as "[earlier context, before this task began]"); oldest first; total ≤ 60000 chars with an
   // explicit "[… N chars truncated]" marker; non-text content is impossible in UPS text and therefore not represented
```

**Module exports** (WP5):
```js
// hooks/hook.mjs: argv[2] = sub; reads stdin; dispatches to lib/hooks/<sub>.mjs; prints stdout JSON; exits with the returned code
// lib/hooks/<sub>.mjs (each):
export async function run(payload, { env = process.env } = {}): { stdout?: object, stderr?: string, exitCode?: number }
// lib/hooks/common.mjs
export async function readStdinJson(): object | null
export function isRole(env): boolean
export async function failOpen(sub, fn): { stdout?, stderr?, exitCode? }   // logs errors to <home>/logs/hooks.log
export function denyPre(reason): object; export function allowPre(reason): object   // main-session only (never role children)
// lib/interactive/requests.mjs
export async function appendRequest(sl, { promptId, text }): { seq }
export async function readRequests(sl): [{ seq, ts, promptId, text }]
export function isSynthetic(prompt): boolean
// lib/interactive/verify-job.mjs (CLI: node verify-job.mjs run|recover <jobFile>)
export async function runJob(jobFile, { signal } = {}): job
export async function recoverJob(jobFile): job
export function jobIsDead(job): boolean
// lib/mcp/jsonrpc.mjs
export function createRpc({ input = process.stdin, output = process.stdout, onRequest, onNotification, log }): { notify(method, params), close() }
// lib/mcp/server.mjs
export async function main(): void
// lib/mcp/tools.mjs
export const TOOLS: [{ name, description, inputSchema, annotations, _meta }]
export async function callTool(name, args, { meta, env, signal, progress }): { content: [{type:'text', text}], isError?: boolean }
```

### 11.9 Stop policy (`interactive.stopPolicy`: `off` | `nudge` (default) | `gate`)

The hook exits 0 immediately when:
- `CC_RSI_ROLE` is set or `payload.agent_id` is present;
- the policy is `off`;
- `background_tasks` is non-empty (only `additionalContext` is added then);
- or, under `nudge`, `stop_hook_active` is true.

Otherwise the first matching row blocks with `{"decision":"block","reason": R}`:

| # | Condition | R | nudge | gate |
|---|---|---|---|---|
| 1 | `job` running | "A cc-rsi verification is still running. Call wait_verdict to receive its verdict before you finish." | once per job | ≤ `stopGateMax` per prompt |
| 2 | `learning` open | "A cc-rsi learning phase is open: finish it with memory_commit (use the code from the last stage message), or call memory_commit with abandon:true." | once per episode | ≤ max |
| 3 | git project, `current = statusDigest(root)` (3 s cap) ≠ `task.openDigest`, and no current verdict covers `current` | "You changed the workspace for this task but no independent verification covers the current state. If the task is complete and non-trivial, call submit; otherwise state plainly that the result is unverified, and finish." | once per digest | ≤ max, then allow and record `stop.unverifiedStops++` |
| 4 | mode learn, `learnTarget` exists and its verdict is current | "This verified experience has not been learned. Call learn if it holds something reusable for a future task; otherwise finish." | once per verdict | once |

`stopGateMax` = 3 per `prompt_id` (state `stop.gate`). Claude Code's own cap of 8 consecutive blocks also applies. A git timeout skips row 3.

### 11.10 Memory exposure and interactive learning

**Read-only view** (`lib/interactive/memview.mjs`):
```js
export async function refreshView({ store, viewDir, viewJson }): { changed: boolean, treeSha256 }
```
- If `viewTreeHash(viewDir) !== store.inventory().treeSha256` → `materializeView(store.memoryDir, viewDir, {readOnly:true})` and write `view.json`.
- It is called by SessionStart and by UserPromptSubmit when the cheap `inventory.json` hash differs from `view.json`. A Bash edit to the view is therefore discarded at the next refresh, which is RSIAgent's discard-by-construction.

**Learning**:
- `learn` → `guidanceLearnStart` (distillation, owner `actor`, the draft path, the limits, the confirm code).
- `memory_commit` #1 → reconciliation with a new code.
- `memory_commit` #2 → the commit outcome texts (`guidanceCommitResult`):
  - `promoted`: "Memory promoted (PASS experience). created: …; modified: …; deleted: …. Tree <12hex>, N files."
  - `limit`: condense, with the detail and a new code;
  - `conflict`: `rebaseDraft`, then the conflict text with a new code;
  - `quarantined`: neutral;
  - `frozen` / `sealed` / `tamper`: refusals, draft kept.
- Drafts survive restarts: the session owner is kept while `<P>/sessions/<sid>` exists. `cc-rsi memory drafts --prune` is human-only.

### 11.11 MCP server (`mcp/server.mjs` → `lib/mcp/*`)

**`.mcp.json`** (exact):
```json
{"mcpServers": {"rsi": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"], "timeout": 600000, "alwaysLoad": true,
  "env": {"CC_RSI_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}", "CC_RSI_OPT_VERIFIER_MODEL": "${user_config.verifier_model}",
          "CC_RSI_OPT_STOP_POLICY": "${user_config.stop_policy}", "CC_RSI_OPT_SANDBOX": "${user_config.sandbox}"}}}}
```

**Protocol** (`jsonrpc.mjs`, `server.mjs`):
- Newline-delimited JSON-RPC 2.0 over stdio. Stdout carries protocol frames only; logs go to `<home>/logs/mcp.log`.
- Messages:

  | Message | Handling |
  |---|---|
  | `initialize` | echo the client `protocolVersion` if it is in `["2025-11-25","2025-06-18","2025-03-26","2024-11-05"]`, else the newest; return `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo:{name:"cc-rsi", version}, instructions}` |
  | `notifications/*` | ignored, except `notifications/cancelled {requestId}`, which aborts that request's wait (the job continues) |
  | `ping` | `{}` |
  | `tools/list` | the catalog below |
  | `tools/call` | dispatch |
  | any other method with an id (incl. `server/discover` [V E9]) | `{"code":-32601,"message":"Method not found"}` |
  | malformed JSON | `-32700` with id null |
  | batch array or missing method | `-32600` |
  | unknown tool | `isError` result |

- `instructions` (≤ 1500 chars): "cc-rsi runs an independent Verifier for your work in this project. When a non-trivial task is complete, call submit; the verdict (PASS/FAIL/UNVERIFIED) comes from a separate Claude Code process that sees only the user's request and the workspace. Act on FAIL by repairing and submitting again. After a terminal verdict, call learn to distill reusable experience into the project memory directory listed in your context."
- Under `CC_RSI_ROLE` every tool returns `isError` `role`.
- Start-up does no store I/O. At start it sweeps attestations older than 1 h.
- Every tool definition carries `_meta: {"anthropic/maxResultSizeChars": 200000}` and annotations: `status` → `{readOnlyHint:true}`; the others → `{readOnlyHint:false, destructiveHint:false, idempotentHint:false}`.
- **Progress**: during a wait, every 5 s send `notifications/progress {progressToken, progress: elapsedSec, total: waitSec, message: "independent verification running (<n> s)"}` when the request carried `_meta.progressToken`. This also resets the stdio idle timer.

**`waitSeconds(config, env)`** = `min(config.interactive.waitSeconds (default 100, max 110), CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS > 0 ? ms/1000 − 10 : ∞)`, with a floor of 10 (J2-12).

**Tool catalog** (full names `mcp__plugin_cc-rsi_rsi__<name>`):

| Tool | inputSchema | Result text | Callers |
|---|---|---|---|
| `submit` | `{"type":"object","properties":{"evidence_leads":{"type":"array","maxItems":16,"items":{"type":"object","properties":{"claim":{"type":"string","minLength":1,"maxLength":2000},"probe":{"type":"string","minLength":1,"maxLength":4000}},"required":["claim","probe"],"additionalProperties":false}}},"additionalProperties":false}` | `guidanceVerdict` (first line `cc-rsi · Verifier: VERDICT: X (generation g, isolation=m, model=…)`, then the verbatim report, then guidance), or `VERIFICATION RUNNING (job <id>, generation <g>) …`, or `INFRASTRUCTURE: …` (`isError:true`), or a refusal (`isError:true`) | main Actor (attested, no `agent_id`) |
| `wait_verdict` | `{"type":"object","properties":{},"additionalProperties":false}` | the same as `submit` for the session's running or undelivered job, else `"No verification is pending. Last verdict: …"` | main Actor |
| `learn` | `{}` | `guidanceLearnStart` or a refusal | main Actor, mode learn |
| `memory_commit` | `{"type":"object","properties":{"confirm":{"type":"string","pattern":"^[0-9a-f]{6}$"},"abandon":{"type":"boolean"}},"required":["confirm"],"additionalProperties":false}` | `guidanceCommitResult` | main Actor, learning open |
| `status` | `{}` | §11.12 | main session and subagents (read-only) |

Tool descriptions (≤ 600 chars each; WP5 writes them, adapted from `dsh-host-messages.md` §rsi_submit/§rsi_learn/§rsi_memory_commit):
- `submit`: "Submit the current workspace for independent verification when a non-trivial task is complete. A separate Verifier (another Claude Code process) inspects the live workspace against the user's own recent messages; it never sees your reasoning. File edits and shell commands are paused until the verdict. After an UNVERIFIED verdict, pass evidence_leads: CLAIM/PROBE pairs where each probe is one read-only command that prints PASS only when the claim holds."
- `wait_verdict`: "Wait for (up to ~100 s) and receive the verdict of a running verification."
- `learn`: "After a terminal verdict (PASS or FAIL), open a learning phase: distill what a future agent should reuse into a draft of the project memory, then call memory_commit twice (reconcile, then promote) with the confirmation codes you are given."
- `memory_commit`: "Advance the open learning phase. Pass the confirmation code from the latest stage message; abandon:true discards the draft."
- `status`: "Show cc-rsi state for this session and project."

### 11.12 `status` text
```
cc-rsi status — session <sid8>, project <key>
mode: learn | memory: <n> files, <kib> KiB, tree <12hex> (intact|CHANGED OUTSIDE A COMMIT) | frozen: no | sealed: no
task <seq>: generation <g>; last verdict <V> (current|stale: workspace changed since inspection|n/a: not a git project)
verification: running (job <id>, <s> s) | none
learning: open (stage <stage>) | none
isolation: Verifier <sandbox|rollback> (<reason>) | Verifier model: <m> (<source>)
lineages: <id> <phase> <status> (<counters>), …   (ids only; never report text or scores)
sealed evaluations: <count> recorded (scores are shown only in a terminal: cc-rsi eval show)
```

### 11.13 Interactive failure modes

| Failure | Behaviour |
|---|---|
| Hooks disabled (`disableAllHooks`, managed-only) | `submit` refuses (`not_attested`). There is no SessionStart context. `cc-rsi doctor` explains. |
| Verification longer than the wait | `VERIFICATION RUNNING`. The rewake hook wakes the Actor [U], else the Actor calls `wait_verdict`. Edits stay paused meanwhile. |
| Job process died | Recovery (§11.5) restores and reports `INFRASTRUCTURE: … job_died`. |
| Verifier API errors | Transient errors are retried within 1800 s of pauses (the in-child watchdog handles 429/529 first), then infra `transient_exhausted`. |
| Invalid Verifier model (F3) | Infra `config`, naming the model and pointing to `verifier_model`. |
| Auth failure in the child (`--restricted` ignores user settings) | Infra `auth`: "run cc-rsi doctor --live; apiKeyHelper/env from ~/.claude/settings.json are forwarded automatically". |
| Restore failed | The lock is kept (fail closed). The guard explains. `cc-rsi doctor --release-lock <root>` (human-only) releases it after the user inspects `<displaced>`. |
| Main session `/clear` | A new session id gives a fresh task state. The old job finishes and records into the old session. |

---

## 12. Exploration lineages (`lib/engine`, WP6)

### 12.1 Memoized op journal (`journal.mjs`) — PR §5.2, with the J2-5 determinism rule
```js
export class OpJournal {
  static async open(lineageDir): OpJournal          // reads ops.jsonl (torn-tail tolerant), builds the index; blobs in <dir>/blobs/
  isDone(key): boolean; result(key): any | undefined; hasStart(key): boolean
  async op(key, kind, args, fn /* ({ recovering, key }) → result (JSON-serialisable) */): result
  async event(key, type, data = {}): void           // = op(key, 'event', {type}, () => appendEvent({ts, type, lineage, ...data}))
  hasOverride(key): boolean; async addOverride(key, data = {}): void   // used only by `explore resume`
  keysWithPrefix(prefix): string[]                  // e.g. restarts of a context
}
export class ReplayDivergence extends InfraError {} // cls 'replay_divergence'
```
**Record format** (`ops.jsonl`, fsync per line):
```json
{"seq": 17, "key": "w001/b:csv/a1/work/m2", "kind": "send", "argsSha": "…", "status": "start" | "done", "ts": "…",
 "result": {"…": "…"}, "blob": "sha256" | null}
{"seq": 18, "key": "w001/cur/liveness@4", "kind": "override", "status": "override", "ts": "…", "data": {"by": "cli"}}
```
Results larger than 4 KiB are stored in `blobs/<sha256>.json`, and the record holds the `blob` id.

**`op` semantics:**
- If `done` exists for the key → compare `kind` and `argsSha = sha256(canonicalJson(args))`. A mismatch throws `ReplayDivergence`. Otherwise return the recorded result.
- If only `start` exists → run `fn({recovering:true})` and append `done`.
- Otherwise append `start`, run `fn({recovering:false})`, append `done`.
- If `fn` throws → no `done` is written, and the error propagates.
- Ops may nest (inner keys differ).
- The same key must never run concurrently (assert).
- Appends are serialised through one promise chain.

**Determinism rules** (MUST; checked by the crash matrix):
1. Every side effect is inside an op: role sends, fs writes, store mutations and protocol events.
2. **Every filesystem or store observation that steers control flow is inside an op**, and the engine branches only on the recorded result. That covers:
   - shape gates;
   - authoring listings;
   - `parseWave`/`parseDecision` validation that touches fs;
   - `projectManifest` comparisons (the resume `changed` flag);
   - fingerprint comparisons;
   - `verifyTree`;
   - store hash and tamper checks;
   - notes reads;
   - audit results;
   - commit outcomes.
   Commit outcomes `limit` and `conflict` are recorded results, not throws.
3. uuids are generated only inside ops (context open, restart).
4. No `Date.now()`/`Math.random()` in control flow. Config, models, prompts and isolation come from `lineage.json` and the prompt snapshot.
5. Counters (projects done, practice count, target cycles, cost) are recomputed from recorded results on every run.
6. **Protocol events** (§12.3) are written only through `j.event`, so replay never duplicates them. **Runtime events** (`TRANSPORT_PAUSE`, `ISOLATION_DEGRADED`, `GUARD_GAP`, `ROLE_INVOCATION`, `LINEAGE_PAUSED`, `LINEAGE_RESUMED`, `OVERRIDE_APPLIED`) describe physical occurrences and may repeat across physical attempts.

### 12.2 Creating a lineage (`records.mjs createLineage`, called by `cc-rsi explore start`)
```js
export async function preflight(opts): { plan: string, blockers: string[], lineage: object /* would-be lineage.json */ }
export async function createLineage(opts): { id, dir }
// opts = { home, projectRoot, phase: 'broad'|'deep'|'frozen', id?, direction?, directionFile?, target?, targetFile?, fixturesDir?,
//          targetConditioned?, models: {actor, verifier, curriculum, escalation, summarizer}, sessionId?, allowUnconfined?,
//          config, pluginRoot }
```
**Blockers** (each refuses the start):
- `CC_RSI_ROLE` is set.
- The id is invalid or `lineage.json` already exists.
- Wrong inputs for the phase:
  - broad needs `direction`, or `target` with `targetConditioned`;
  - deep and frozen need `target`;
  - `fixturesDir` must pass `shapeGate`.
- Store state:
  - for broad/deep: frozen, sealed (without `learningAfterSealed`) or tampered;
  - for frozen: the store is not frozen or not frozen-intact.
- Another live engine for the same `id`.
- Sandbox decision:
  - `isolation.sandbox` `auto` without a sandbox and without `allowUnconfined` → blocker (J2-9): "no OS sandbox is available (<reason>); lineage children would run Bash unattended and unconfined. Re-run with --allow-unconfined (or set isolation.allowUnconfined in ~/.cc-rsi/config.json) to accept this, preferably in a disposable container or VM.";
  - `require` without a sandbox → blocker;
  - `off` → requires `allowUnconfined` too.
- `claude` is missing, or `missingFlags` is non-empty.

**Start sequence:**
1. Resolve the models (§10.3, chain with `sessionId`'s `session.json` when given). Record the resolved strings and their sources.
2. `snapshotPrompts(<dir>/prompts)`.
3. `lock` = `{pluginRoot, pluginRev (sha256 of lib/engine/*.mjs + hooks/role-guard.mjs + lib/guard/*.mjs + lib/runtime/*.mjs), guardSha, ccVersion, promptSha (from the snapshot), configSha}`.
4. Write `lineage.json`, `state.json` `{status:'starting'}`.
5. `initInertRepo(<home>/work)`. Create the `<W>` dirs.
6. Spawn the engine detached: `spawnDetached(process.execPath, [<pluginRoot>/lib/engine/daemon.mjs, lineageDir], {cwd: lineageDir, logFile: <dir>/engine.log, env: process.env minus CC_RSI_* and CLAUDECODE})`. With `--foreground`: `await runEngine(lineageDir)` in-process (tests, e2e).

**Auth preflight**, unless `--skip-auth-probe`: one tiny summarizer-shaped child with the exact flags, env and forwarded settings (`--tools ""`, "Reply with the single word OK"). Failure → blocker `auth` with the classified detail (J2-2).

### 12.3 Records (`<P>/lineages/<id>/`)
```
lineage.json   immutable except lock.driftAccepted[]
state.json     derived status (rewritten by the engine after every step)
ops.jsonl      §12.1                blobs/<sha>.json
events.jsonl   {ts, type, lineage, ...}
result.json    terminal record (snake_case)
engine.lock    LeaseLock (pid, host, token; 5 s heartbeat; 30 s lease)
engine.log     stdout/stderr of the daemon
prompts/       template snapshot (render source for this lineage)
ctx/<safeCtxKey>/  RoleContext logDirs (invocations, sessions registry, pin.md)
priv/          private artifacts (role-invisible): w<NNN>/{decision.json, memory_snapshot/, leftover/, <pid>/{fixtures/, a<n>/candidate/,
               infra_attempts/attempt_NNN/}}, t<NNN>/{memory_snapshot/, checkpoints/g<NNN>/, manifests/g<NNN>.json, worklog.md},
               p<NNN>/{fixtures/, memory_snapshot/, candidate-g<NNN>/}, target-fixtures/, final-candidate/{tree/, manifest.json},
               curriculum/notes.md
```
`lineage.json`:
```json
{"v": 1, "id": "deep-20261013120000", "phase": "deep", "projectKey": "…", "projectRoot": "/abs", "createdAt": "…",
 "direction": {"text": "…", "sha256": "…"} | null, "targetConditioned": false,
 "target": {"text": "…", "sha256": "…", "fixturesCaptured": true} | null,
 "config": {"exploration": {}, "transport": {}, "isolation": {}, "memory": {}, "audit": {}, "children": {}},
 "configSha": "…",
 "models": {"actor": "sonnet" | null, "verifier": "opus" | null, "curriculum": null, "escalation": null, "summarizer": null},
 "modelSources": {"actor": "config"},
 "isolation": {"mode": "sandbox" | "unconfined", "reason": "…", "allowUnconfined": true},
 "lock": {"pluginRoot": "/abs", "pluginRev": "…", "guardSha": "…", "ccVersion": "2.1.296", "promptSha": {"name": "sha"},
          "configSha": "…", "driftAccepted": []},
 "memoryTreeAtStart": "…", "storeRoot": "/abs", "workRoot": "/abs", "startedBy": {"sessionId": "…" | null, "cli": true}}
```
`state.json`:
```json
{"v": 1, "id": "…", "phase": "deep",
 "status": "starting" | "running" | "paused_user" | "paused_infra" | "completed" | "abandoned" | "quarantined",
 "pausedAt": "key" | null, "infra": {"cls": "…", "detail": "…"} | null, "wave": 2, "projectsDone": 5, "targetCycles": 1,
 "practiceProjects": 2, "costUsd": 1.23, "lastEvent": "MEMORY_COMMITTED", "pid": 123, "updatedAt": "…"}
```
**Protocol events** (RSIAgent/dsh vocabulary; fields after `ts, type, lineage`):

| Event | Fields |
|---|---|
| `LINEAGE_STARTED` | `phase, memoryTree, isolation` |
| `WAVE_AUTHORED` | `wave, ids, rationaleSha` |
| `WAVE_FIXTURES_CAPTURED` | `wave, ids` |
| `PROJECT_SUBMITTED` | `episode` |
| `PROJECT_VERIFIED` | `episode, generation, verdict, reportSha` |
| `PROJECT_RESTARTED_UNSCORED` | `episode, attempt, cls` |
| `VERIFIER_EFFECTS_ROLLED_BACK` | `episode, generation, paths` |
| `VERIFIER_EFFECTS_OBSERVED` | `episode, generation` |
| `WAVE_BLOCKED` | `wave, failed: [{pid, cls}]` |
| `MEMORY_COMMITTED` | `episode, kind, outcome, treeBefore, treeAfter, created, modified, deleted` |
| `MEMORY_CONFLICT_REBASED` | `episode, k` |
| `WAVE_COMPLETED` | `wave, projects, memoryTree` |
| `PHASE1_TERMINATED` | `termination` |
| `TARGET_STARTED` | `cycle` |
| `TARGET_VERIFIED` | `cycle, generation, verdict, reportSha, forced` |
| `TARGET_STALLED` | `cycle, reason` |
| `TARGET_RESUMED` | `cycle, resume, mode: handoff\|pivot, escalated, verifierSwapped` |
| `TARGET_LEARNING_COMPLETED` | `cycle, verdict, treeAfter` |
| `CURRICULUM_DECIDED` | `k, decision` |
| `PRACTICE_STARTED` | `p` |
| `PRACTICE_VERIFIED` | `p, generation, verdict` |
| `PRACTICE_LEARNING_COMPLETED` | `p, verdict, treeAfter` |
| `TARGET_LOOP_TERMINATED` | `termination` |
| `FROZEN_ATTEMPT_COMPLETED` | `verdict` |
| `LINEAGE_QUARANTINED` | — (never the reason) |
| `LINEAGE_ABANDONED` | — |
| `ROLE_CONTEXT_STARTED` | `ctx, role, sessionId, model` |
| `ROLE_CONTEXT_RESTARTED` | `ctx, oldSessionId, newSessionId, reason` |
| `DRIFT_ACCEPTED` | `diff` |

**`result.json`** (snake_case; written in the `final` op, or by `abandon`):
```json
{"schema_version": 1, "lineage": "…", "phase": "broad" | "deep" | "frozen", "termination": "…", "rationale": "…",
 "isolation": {"mode": "…", "reason": "…"}, "stop_policy": "curriculum_review",
 "waves": 3, "projects": [{"id": "csv-merge", "wave": 1, "episode": "…", "instruction_sha256": "…", "verdict": "PASS",
                           "report_sha256": "…", "commit": {"tree_before": "…", "tree_after": "…", "created": [], "modified": [], "deleted": []} }],
 "target_cycles": 2, "practice_projects": 3, "history": ["- Phase-2 target attempt 1: FAIL"],
 "target_verifier_verdict": "PASS" | "FAIL" | "UNVERIFIED" | null, "curriculum_decision": "READY_FOR_TARGET" | null,
 "candidate_root": "/abs", "candidate_copy": "/abs/priv/final-candidate", "candidate_digest": "…",
 "initial_memory_tree_sha256": "…", "final_memory_tree_sha256": "…", "frozen_tree_sha256": "…" | null,
 "official_evaluator_calls": 0, "official_evaluator_feedback_entered_learning": false,
 "models": {"actor": "claude-…", "verifier": "claude-…"}, "cost_usd": 3.21, "infra_pauses": 2, "cc_version": "2.1.296",
 "lock_sha256": "…", "finished_at": "…"}
```
Terminations:
- broad: `budget_exhausted | saturated | stalled`;
- deep: `verifier_pass | verifier_pass_curriculum_ready | verifier_pass_curriculum_stalled | curriculum_stalled_final_target_test | target_harness_unverified | budget_exhausted`;
- frozen: `frozen_attempt_complete | target_harness_unverified`;
- any phase: `quarantined | abandoned`.

`infra` is never terminal: the lineage pauses, and `abandon` records `abandoned` with `rationale` = the last infra detail.

### 12.4 Daemon (`daemon.mjs`)
```js
export async function runEngine(lineageDir, { signal } = {}): { status }
// CLI entry: node lib/engine/daemon.mjs <lineageDir>   (refuses when CC_RSI_ROLE is set)
```
```js
// EngineRun (passed to every phase function)
// { j: OpJournal, lineage: object /* lineage.json */, lineageDir, layout /* lineageLayout */, pl, home, pluginRoot, store: MemoryStore,
//   config, models, isolation, signal: AbortSignal, logger, runtimeEvent(type, data) }
export async function runBroad(run): { termination, rationale }      // broad.mjs
export async function runDeep(run): { termination, attempt }          // deep.mjs
export async function runFrozen(run): { termination, attempt }        // frozen.mjs
```
1. Acquire `engine.lock` (no wait). If it is held live → exit 3.
2. Load `lineage.json` and `setPromptsDir(<dir>/prompts)`. Open the store and the journal. Emit the runtime event `LINEAGE_RESUMED` if ops exist.
3. `state.status = running`.
4. Install SIGTERM/SIGINT handlers: set an `AbortController`, which propagates to children through RoleContext `signal` (`killedBy:'stop'`).
5. Dispatch `broad | deep | frozen`.
6. On return: `final` op, `state.status = completed`, release the lock, exit 0.
7. On `InterruptedError`: `state = paused_user`, runtime `LINEAGE_PAUSED{reason:'user'}`, exit 0.
8. On `MemoryQuarantineError` or an audit hit: op `final:quarantined` → write `result.json` `{termination:'quarantined'}`, `LINEAGE_QUARANTINED`, `state = quarantined`.
9. On `InfraError` (incl. `TransportInfraError`, `ReplayDivergence`, `MemoryTamperError` → cls `memory_tamper`, `MemoryFrozenError` → cls `memory_frozen`): `state = paused_infra` `{pausedAt: err.extra.pausedAt ?? err.extra.opKey, infra:{cls, detail}}`, `LINEAGE_PAUSED`, exit 0.
10. Any other error → `paused_infra` with cls `engine_error` (stack in `engine.log`).

`cc-rsi explore stop` sends SIGTERM to the engine pid only. The engine stops its children gracefully. After 60 s the CLI escalates with `killGracefully(pid, {group:true})`.

### 12.5 Role contexts in lineages (`roles.mjs`)
```js
export class EngineContext {     // journaled wrapper around RoleContext
  constructor(j, key, specFn /* (phase) → RoleSpec */, { model, role })
  async open(): void             // op `${key}/open` → {sessionId: uuid()} ; event ROLE_CONTEXT_STARTED
  get sessionId(): string        // open result, then the latest done `${key}/restart:<n>` result
  setPhase(phase /* 'work'|'learn' */): void
  async send(opKey, message): Reply
     // j.op(opKey, 'send', {ctx: key, msgSha: sha256(message), phase}, ({recovering}) => RoleContext(spec, {sessionId}).send(message, {recovering}))
     // InfraError 'session_missing' with established:false → op `${key}/restart:<n>` {sessionId: uuid()} + ROLE_CONTEXT_RESTARTED,
     //   then retry the send ONCE with the original message (first message of the new session);
     // 'session_missing' established:true → rethrow as InfraError('context_lost')
     // every other error: rethrow with extra.opKey = opKey
}
export function specFor({ role, phase, lineage, ep, W, home, pluginRoot, config, models, isolation, ... }): RoleSpec   // §10.6 table
```
Spec rules:
- `logDir = <lineageDir>/ctx/<safeName(key)>`.
- Pin file for target/frozen Actors: `<logDir>/pin.md` = `taskPin({messages:[{text: target, current:true}]})` + `memoryRevisit('fold')`.
- `lossless` per §10.12.
- `sandboxDegrade = lineage.isolation.allowUnconfined ? 'allow' : 'refuse'`.
- Hidden roots and tokens per §4.3, computed from the dirs that exist at spawn time.
- System texts:
  - Actor and Curriculum: `engineSystem()` (+ `curriculumSystem()` for the Curriculum);
  - Verifier: `verifierSystem({location, sandbox, allowUnverified})`;
  - Summarizer: `summarizerSystem()` or `strategyReviewSystem()`.

### 12.6 Journaled handoff phases (`steps.mjs`)
```js
export async function journaledConverse(j, prefix, ctx: EngineContext, { first, parse /* (reply) → Parsed | Promise<Parsed> */,
       continuation, stallContinuation, policy }): { value, reply }
   // converse({ send: (m, i) => ctx.send(`${prefix}/m${i}`, m),
   //            parse: (r, i) => j.op(`${prefix}/p${i}`, 'parse', {sha: sha256(r.text)}, () => parse(r)),   // fs-touching parses recorded
   //            overrideFor: k => j.hasOverride(`${prefix}/${k}`), … })
   // TransportInfraError → rethrown with extra.pausedAt = `${prefix}/${livenessKey}`
export async function freePhase(j, prefix, ctx, message): Reply
   // RSIAgent _run_free_phase: any reply ends the phase; a truncated reply gets one truncatedContinuation (also ignored)
export const ACTOR_TOKEN = 'STATUS: SUBMIT'
```

### 12.7 Protected inspections (`inspect.mjs`)

**Practice (replay)**: Phase-1 branch and Phase-2 practice.
```js
export async function inspectPractice(j, K, { verifierCtx, ep, gen, candidateCapture, fixturesCapture, phase, instruction,
                                               leads, allowUnverified, W }): { verdict, report, reportSha }
```
1. op `${K}/pre`:
   - `rm <W>/actor-private/<ep>/memory` (the Actor memory is gone before inspection, J1-4);
   - `replayTree(candidateCapture → <W>/verify/<ep>/candidate)`;
   - fresh scratch `<W>/verify-scratch/<ep>-v<vk>`;
   - Phase 2: `stageReadOnlyView(fixturesCapture → <W>/verify/<ep>/original)`;
   - result: `{fp: treeFingerprint(candidate), delta: describeDelta(manifestDelta(fixtures→candidate))}`.
2. `mechanical` = `verifierPracticeContext({phase, evidenceRound: gen > 1})` + `delta`. `task` = `instruction` with `<PROJECT_ROOT>` → the candidate path.
3. `journaledConverse(j, ${K}/v, verifierCtx, {first: verifierCharter({generation: gen, task, candidateRoot, scratchDir, mechanical, leads, originalFixturesDir, practiceContext}), parse: r => parseVerdict(r.text, {allowUnverified}), continuation: verifierContinuation, stallContinuation: verifierContinuation('the harness resumed after a pause')})`.
4. op `${K}/post`:
   - if the candidate fingerprint changed → in sandbox mode infra `effect_isolation_failed`; else event `VERIFIER_EFFECTS_OBSERVED` (the capture is immutable);
   - Phase 2: `verifyTree(original)` must hold, else infra `original_fixtures_changed`; then `removeView`;
   - `putReport`;
   - result `{verdict, reportSha}`.

**Target (live)**: Phase-2 target attempts and Phase-3.
```js
export async function inspectTarget(j, K, { verifierCtx, attempt, gen, root, actorMemoryDir, snapshotDir, before, prevManifest,
                                             leads, forced, W }): { verdict, report, reportSha, manifest }
```
1. op `${K}/pre`:
   - `rm actorMemoryDir`;
   - if the checkpoint `<priv>/t<NNN>/checkpoints/g<gen>` is absent → full `copyTree(root → it)`;
   - `fp = treeFingerprint(root)`;
   - `delta = describeDelta(manifestDelta(before, projectManifest(root)), {header:'since this target attempt began'})`;
   - `changed = contentDelta(prevManifest, manifest(root))`;
   - persist `manifests/g<gen>.json`.
2. Charter: `verifierCharter({generation: gen, task: target verbatim, candidateRoot: root, scratchDir: <W>/verify-scratch/<t>-v<vk> (persists per Verifier context), mechanical: delta, changedSinceLast, leads})`.
3. `journaledConverse(${K}/v, …)` with `allowUnverified: true`.
4. op `${K}/post`:
   - if `treeFingerprint(root) ≠ fp` → `rm root`, copy the checkpoint back, event `VERIFIER_EFFECTS_ROLLED_BACK{paths}`;
   - `materializeView(snapshotDir → actorMemoryDir, {readOnly:true})`;
   - remove the checkpoint;
   - `putReport`.
   Recovering mode: `pre` re-uses an existing checkpoint; `post` always restores first. Both are idempotent.

### 12.8 Learning in lineages (`learn.mjs`; RSIAgent `_promote_learning`, dsh `steps.ts:206-262`)
```js
export async function learnOp(j, L, actorCtx, { store, episode, kind, outcome, report, memoryDir, diagnosis: boolean, lineage }):
  { record, diagnosisText: string | null }
```
1. op `${L}/open`: `store.assertCanonicalIntact()`; `store.openDraft(episode, {dir: memoryDir, fresh: true, owner:{kind:'engine', pid, host, lineage}})`. This copies the **current** canonical memory, which is RSIAgent's re-push. Then `actorCtx.setPhase('learn')`.
2. `freePhase(${L}/distill, distillation({outcome, report, memoryDir, limits, owner:'engine'}))`.
3. `freePhase(${L}/reconcile, reconciliation({memoryDir, owner:'engine'}))`.
4. If `diagnosis`: `journaledConverse(${L}/diagnosis, diagnosis(), parse: non-empty final text)`. The diagnosis text goes to the Curriculum only.
5. For `k = 1..4`, op `${L}/commit:${k}` → `store.commit(episode, {kind, outcome, lineage})` with these recorded results:
   - `{ok:true, record}`;
   - `{ok:false, reason:'limit', detail}`;
   - `{ok:false, reason:'conflict'}`.
   Quarantine, frozen and tamper throw. Then:
   - ok → event `MEMORY_COMMITTED`, `actorCtx.setPhase('work')`, return;
   - limit → `freePhase(${L}/condense:${k}, limitCondense({detail, memoryDir, owner:'engine'}))`;
   - conflict → op `${L}/rebase:${k}` → `store.rebaseDraft(episode)` → event `MEMORY_CONFLICT_REBASED`; `freePhase(${L}/conflict:${k}, conflict({prevDir, draftDir: memoryDir, owner:'engine'}))`.
6. After 4 attempts → InfraError(`commit_ceiling`).

Infra anywhere → the draft is kept, so resume continues it. Committed episodes are never committed twice (idempotent by episode).

### 12.9 Target attempt (`target.mjs`) — RSIAgent `run_with_resume` + Phase-2 rules; shared by deep and frozen
```js
export async function targetAttempt(j, T /* 't001' */, { lineage, store, frozen: boolean, ctx }): { verdict, report, reportSha, diagnosis, root }
```
```
op T/init:  replay priv/target-fixtures → <W>/projects/T (or mkdir empty); snapshot canonical → priv/T/memory_snapshot
            (frozen: the frozen canonical tree); materializeView(snapshot → <W>/actor-private/T/memory, ro);
            before = projectManifest(root)                                              → {before, snapshotTree}
event T/ev:TARGET_STARTED
actorModel = models.actor; verifierModel = models.verifier; swapped = false; resumes = 0; gen = 0; worklog = []
verifier   = EngineContext(`T/verifier@${vid}`, Verifier live)   // vid = safeName(effective(verifierModel)) + '-' + sha256(systemText).slice(0,8);
                                                                  // one context per identity; persists across Actor resumes
for s = 0, 1, …:
  actor = EngineContext(`T/actor@${s}`, Actor work phase, model actorModel, pinned, compaction on)
  opening = s == 0 ? targetActorOpening({target, root, memoryDir, inventory, empty, frozen}) : resumeText   (computed at resume)
  unverified = 0; repairs = 0; leads = ''
  try:
    h = journaledConverse(`T/s${s}/work`, actor, first: opening, parse: parseSubmit ∧ shapeGate(root) [op], continuation: transportContinuation)
    worklog.push(`HANDOFF:\n${h.body}`)
    loop:
      gen++; r = inspectTarget(j, `T/g${gen}`, {…, leads}); event TARGET_VERIFIED{forced:false}; worklog.push(`VERIFIER REPORT (generation ${gen}):\n${r.report}`)
      if r.verdict == PASS → TERMINAL
      if r.verdict == FAIL:
         if !frozen → TERMINAL                                      // verifier_failure_starts_evolution
         if ++repairs ≥ exploration.frozenRepairRounds (8) → throw STALL      // semantic stall, never a pause
         h = journaledConverse(`T/s${s}/repair:${gen}`, actor, disagreement({report}) + leadsRequest-free tail, parse STATUS ∧ shape)  // baseline.yaml same-Actor repair
         leads = ''; continue
      // UNVERIFIED
      if ++unverified ≥ exploration.unverifiedRounds (3) → throw STALL
      h = journaledConverse(`T/s${s}/evidence:${gen}`, actor, unverified({report}) + leadsRequest({interactive:false}),
                            parse: parseSubmit ∧ shapeGate ∧ (parseLeads.problems empty))
      leads = formatLeads(parseLeads(h.body).leads)                 // narrative dropped; only CLAIM/PROBE reach the Verifier
  catch (TransportInfraError from the ACTOR converse) or STALL:
    event T/ev:TARGET_STALLED:${s}
    gen++; r = inspectTarget(j, `T/g${gen}`, {…, leads: '', forced: true}); event TARGET_VERIFIED{forced:true}
    if r.verdict == PASS or (r.verdict == FAIL and !frozen) → TERMINAL (learned by the SAME held Actor `T/actor@${s}`)
    if resumes < exploration.targetResumes (1):
       op T/resume:${resumes+1}/plan: changed = projectManifest(root) != before                          → {changed}
       worklogText = synthesizeWorklog(j, `T/resume:${resumes+1}`, {actorCtxLogDir, digest: worklog})     // §12.10
       review = changed ? '' : strategyReview(j, `T/resume:${resumes+1}/review`, {worklogText, tail})
       resumeText = resumeOpening({changed, worklog: worklogText, review, target, root, memoryDir})
       escalate = models.escalation != null && effective(models.escalation) != effective(actorModel)
       if escalate: if crossModelVerifier && !swapped: verifierModel = models.actor (ORIGINAL Actor model); swapped = true
                                                        verifier = EngineContext(new identity)  // NO history and NO prior reports
                                                        // unless exploration.escalationHandoverReports (then handover:'other-verifier')
                    actorModel = models.escalation
       resumes++; event T/ev:TARGET_RESUMED:${resumes}{mode: changed?'handoff':'pivot', escalated, verifierSwapped}
       continue (next s)
    return {verdict: r.verdict /* UNVERIFIED, or FAIL in frozen */, report, learnable: false}
TERMINAL: if !frozen: L = learnOp(j, `T/learn`, actor, {episode: `${id}-${T}`, kind:'target', outcome: verdict, report, memoryDir, diagnosis:true})
          event T/ev:TARGET_LEARNING_COMPLETED
return {verdict, report, diagnosis: L?.diagnosisText ?? '', root}
```
- `crossModelVerifier` = escalation set ∧ `effective(escalation) === effective(models.verifier)`.
- A Verifier FAIL never triggers a fresh-context pivot. Only stalls do (RSIAgent invariant).
- Verifier transport infra (actionless ×3, ceiling) is **not** a stall: the lineage pauses (`pausedAt` liveness key). On resume, the override sends the stall continuation to the Verifier.

### 12.10 Worklog synthesis (`worklog.mjs`)
```js
export async function synthesizeWorklog(j, K, { lineage, actorCtxLogDir, digest: string[], config }): string
export async function strategyReview(j, K, { worklogText, tail, config }): string
export function digestWorklog(entries: string[], cap = 12000): string     // dsh fallback (handoffs + Verifier reports), newest kept
```
- Enabled when `exploration.synthesizeWorklog` (default true).
- **Messages** are rebuilt from the Actor context's invocation logs (`prompt.md` → `[YOU]`; assistant text and tool_use summaries → `[YOU]`; tool results → `[ENV]`). Take the last 60, each cut to its first 1500 + last 2500 chars.
- `summarizerSystem` + `summarizerRequest({currentLog:'', messages})` is sent in a fresh summarizer context. The op `${K}/summarize` records `{text}`.
- Strategy review is the same mechanism with `strategyReviewSystem` + `strategyReviewAsk({worklog: text[:8000], tail: last 6 messages × 1500 chars})`, capped to 2500 chars.
- Infra or empty output → `digestWorklog(digest)`. That is recorded, and the lineage does not pause for it.

### 12.11 Practice projects (`project.mjs`)
```js
export async function runProjectWithRetry(j, Kbase, opts): BranchResult      // unscored restart (RSIAgent _execute_branch_with_infra_retry)
export async function runProject(j, K, { phase /* 1|2 */, ep, instruction, fixturesCapture, memorySource /* dir to copy */,
                                         lineage, store, attempt }): BranchResult
// BranchResult = { ep, episode, verdict, report, reportSha, actorKey, memoryDir, instruction, generations }
```
`runProject`:
1. op `${K}/replay`: `replayTree(fixturesCapture → <W>/projects/<ep>)`; `materializeView(memorySource → <W>/actor-private/<ep>/memory, ro)` (Phase 1: the wave snapshot; Phase 2: `priv/p<NNN>/memory_snapshot` of canonical).
2. Actor `EngineContext(${K}/actor)`: `journaledConverse(${K}/work, first: practiceActorCharter + actorRuntimeContract, parse: parseSubmit ∧ shapeGate(root))`. Event `PROJECT_SUBMITTED`.
3. op `${K}/capture:g1` → `captureTree(root → priv/…/candidate-g1)`.
4. Verifier `EngineContext(${K}/verifier)`, fresh. Phase 1: `allowUnverified:false`, exactly one inspection. Phase 2: `allowUnverified:true`. Run `inspectPractice(${K}/inspect:g1)`. Event `PROJECT_VERIFIED` (Phase 2: `PRACTICE_VERIFIED`).
5. Phase 2 only, while UNVERIFIED:
   - `n++`; if `n ≥ exploration.unverifiedRounds` and there is no override `${K}/unverified@${gen}` → InfraError(`unverified_exhausted`, `{pausedAt}`). RSIAgent: practice non-PASS/FAIL is infra.
   - Re-materialize the Actor memory (ro).
   - `journaledConverse(${K}/evidence:${gen}, unverified({report}) + leadsRequest)`.
   - `captureTree` → `g+1`.
   - `inspectPractice(${K}/inspect:g${gen+1}, leads)`, on the same Verifier context.
6. Return the result. The Actor context stays resumable for learning after the barrier.

`runProjectWithRetry`:
- For each attempt `a = 1..branchRetries+1`, skip it if `j.isDone(${Kbase}/a${a}/abandon)`.
- Run the attempt. On an `InfraError` whose `cls ∈ BRANCH_RETRYABLE` with `a ≤ branchRetries`, raised before the attempt's Verifier published a report:
  1. op `${Kbase}/a${a}/abandon` → `moveAside(<W>/projects/<ep>, priv/…/infra_attempts)` + `retry_receipt.json {mode:'restart_unscored_branch_from_immutable_fixtures', priorMemoryPromoted:false, cls, detail}`;
  2. event `PROJECT_RESTARTED_UNSCORED`;
  3. next attempt with `ep = <ep>-a<a+1>` and fresh contexts.
- `TransportInfraError` and every non-retryable class are rethrown. RSIAgent never retries boundary or transport-liveness errors.

### 12.12 Phase 1 — broad waves (`broad.mjs`; RSIAgent `evolve_parallel_phase1`, dsh `lineage.ts:395-513`)
```
op init: assertCanonicalIntact; event LINEAGE_STARTED
cur = EngineContext('cur', Curriculum)                                   // one context for the whole lineage
for wave n = 1, 2, …:   W = `w${pad3(n)}`
  if projectsDone ≥ broadProjectBudget or costUsd ≥ maxCostUsd → finish('budget_exhausted')     // wave boundaries only; a wave may overshoot
  op W/prep: assertCanonicalIntact; refresh <W>/curriculum-private/memory (ro copy of canonical); empty authoring/
  d = journaledConverse(`W/cur`, cur, first: waveCharter({direction|target, targetConditioned, priorWave, authoringRoot, memoryDir, notes})
                         + curriculumRuntimeContract, parse: parseWave(text, {ceiling: waveCeiling}) ∧ (WAVE ⇒ ∀id shapeGate(authoring/<id>)
                         ∧ no other entries in authoring/) [op], continuation: waveContinuation)       // drafts kept across retries
  op W/audit: notes = read notes.md; hit = store.auditTexts([d.text, notes, …fixture texts ≤1 MiB each, names]) → {hit, notesSha}
     hit → throw quarantine
  SATURATED|STALLED → op W/leftover (move authoring → priv/W/leftover); finish('saturated'|'stalled', rationale = d.rationale)
  event W/ev:WAVE_AUTHORED
  op W/capture: snapshot canonical → priv/W/memory_snapshot; ∀id in authored order captureTree(authoring/id → priv/W/id/fixtures); empty authoring;
                write priv/W/decision.json
  event W/ev:WAVE_FIXTURES_CAPTURED
  results = pool(waveConcurrency, ids, id => runProjectWithRetry(j, `W/b:${id}`, {phase:1, ep:`W-${id}`, memorySource: priv/W/memory_snapshot, …}))
  BARRIER: allSettled. Any rejection → event W/ev:WAVE_BLOCKED (only once all have settled); NO commits; rethrow the first error,
           preferring quarantine > liveness/transport > other infra. On resume, fulfilled branches replay instantly.
  for id in authored order:                                              // serial consolidation on the LATEST canonical memory
     b = results[id]; L = learnOp(j, `W/learn:${id}`, actorCtx(b), {episode: `${lineage}-W-${id}`, kind:'practice', outcome: b.verdict,
                                                                    report: b.report, memoryDir: b.memoryDir, diagnosis: false})
     outcomes.push(outcomeText({instruction, verdict, reports:[report], memoryChanges: L.record}))
  event W/ev:WAVE_COMPLETED; priorWave = waveOutcomes({wave: n, rationale: d.rationale, outcomes})
finish(termination): op final → result.json; event PHASE1_TERMINATED
```

### 12.13 Phase 2 — deep target/practice (`deep.mjs`; RSIAgent `run_self_evolving_loop`, dsh `lineage.ts:653-777`)
```
op init (assert intact; capture --fixtures → priv/target-fixtures once); event LINEAGE_STARTED
history = []; finalAfterStall = false; finalAfterBudget = false
for c = 1, 2, …:
  a = targetAttempt(j, `t${pad3(c)}`, {frozen:false}); history.push(`- Phase-2 target attempt ${c}: ${a.verdict}`)
  if finalAfterBudget                                             → finish('budget_exhausted')          (verdict recorded, even PASS)
  reviewPass = a.PASS ∧ stopPolicy == 'curriculum_review' ∧ ¬finalAfterStall
  if a.PASS ∧ ¬reviewPass                                         → finish('verifier_pass')
  if finalAfterStall                                              → finish('curriculum_stalled_final_target_test')
  if a.UNVERIFIED                                                 → finish('target_harness_unverified')
  if targetCycleBudget > 0 ∧ c ≥ targetCycleBudget                → finish('budget_exhausted')
  cur = EngineContext('cur', Curriculum)                          // opened lazily after the first attempt; persists for the lineage
  latest = targetOutcomeText({target, verdict: a.verdict, report: a.report, diagnosis: a.diagnosis, lifecycle: true})
  practiceThisEvolution = 0
  for k (global decision counter K):
    if deepPracticeBudget > 0 ∧ practiceProjects ≥ deepPracticeBudget →
        practiceThisEvolution == 0 ? finish('budget_exhausted') : (finalAfterBudget = true; break)
    if costUsd ≥ maxCostUsd → same handling as the practice budget
    op d${pad3(K)}/prep: assert intact; refresh curriculum memory (read_only: ro copy; none: remove); empty practice/authoring
    d = journaledConverse(`d${pad3(K)}/cur`, cur, deepCharter({target, history, latestOutcome: latest, notes, memoryAccess, authoringRoot,
                          memoryDir}) + curriculumRuntimeContract, parse: parseDecision(['PROJECT','READY_FOR_TARGET','STALLED']) ∧
                          (PROJECT ⇒ body ∋ '<PROJECT_ROOT>' ∧ shapeGate(practice/authoring)) [op], continuation: curriculumContinuation)
    op d${pad3(K)}/audit (as broad); event CURRICULUM_DECIDED{k: K, decision}
    READY_FOR_TARGET → break;   STALLED → finalAfterStall = true; break
    PROJECT → p = ++practiceProjects; P = `p${pad3(p)}`
              op P/capture: captureTree(practice/authoring → priv/P/fixtures); snapshot canonical → priv/P/memory_snapshot; empty authoring
              event PRACTICE_STARTED
              b = runProjectWithRetry(j, `P/b`, {phase:2, ep: P, instruction: d.body, memorySource: priv/P/memory_snapshot})
              L = learnOp(j, `P/learn`, actorCtx(b), {episode: `${lineage}-${P}`, kind:'practice', outcome: b.verdict, report: b.report,
                                                     memoryDir: b.memoryDir, diagnosis: true})
              history.push(`- Phase-2 practice project ${P}: ${b.verdict}`)
              latest = outcomeText({instruction: d.body, verdict: b.verdict, reports: b.reports, memoryChanges: L.record, diagnosis: L.diagnosisText})
              event PRACTICE_LEARNING_COMPLETED; practiceThisEvolution++
  if finalAfterBudget → continue                                              // the final fresh target test follows
  if a.PASS ∧ practiceThisEvolution == 0 → finish(finalAfterStall ? 'verifier_pass_curriculum_stalled' : 'verifier_pass_curriculum_ready')
  // otherwise: MANDATORY fresh target attempt (after any practice, and after FAIL + READY_FOR_TARGET with no practice)
finish: op final → captureTree(last target root → priv/final-candidate); candidate_digest = treeFingerprint(priv/final-candidate/tree);
        result.json; event TARGET_LOOP_TERMINATED
```
Invariants:
- Readiness ≠ correctness: `READY_FOR_TARGET` is recorded as `curriculum_decision`, never as a verdict.
- Any practice forces a fresh unchanged-target attempt.
- STALLED buys exactly one final target test.
- UNVERIFIED is never learned.
- Infra never commits.

### 12.14 Phase 3 — frozen lineage (`frozen.mjs`)
```
op init: require store.frozen() and assertFrozenIntact; record frozen tree; event LINEAGE_STARTED
a = targetAttempt(j, 't001', {frozen: true})           // FAIL → same-Actor repair (baseline.yaml); no learning; no Curriculum
op final: assertFrozenIntact (mismatch → infra 'memory_frozen_tamper'); captureTree(root → priv/final-candidate); digest;
          result.json {termination: a.verdict == UNVERIFIED ? 'target_harness_unverified' : 'frozen_attempt_complete',
                       target_verifier_verdict: a.verdict, frozen_tree_sha256, official_evaluator_calls: 0}
event FROZEN_ATTEMPT_COMPLETED
```
The sealed evaluator is **not** run here (§13.4).

### 12.15 Resume, stop, abandon, show (`records.mjs`)
```js
export async function admitResume(lineageDir, { acceptDrift = false }): { ok: boolean, reasons: string[], overrides: string[] }   // pure: zero writes
export async function applyResume(lineageDir, admission): void        // addOverride for liveness/unverified/repairs pause keys; drift record
export async function abandon(lineageDir, { reason }): void           // engine must not be live; result.json termination 'abandoned'
export async function showLineage(lineageDir): string                 // contexts: role, key, sessionId, model, invocations, last class;
                                                                      // hint lines: `claude --resume <sid> --fork-session` (inspect without mutating)
```
**Admission refusals** (each prints `resume refused: <reason>`):
- `result.json` exists (terminal; quarantine is absorbing).
- The engine lock is held live.
- `lock.pluginRoot` is missing or `guardSha`/`pluginRev` differ, without `--accept-drift`.
- The canonical memory is not intact (tamper).
- broad/deep: the store is frozen or sealed. frozen: the store is not frozen or not intact.

`ccVersion` changes are only reported.

**Override keys** (applied when `state.pausedAt` ends with one of them): `/liveness@<n>` (grants a stall continuation) and `/unverified@<n>` (grants one more Phase-2 practice evidence round). Every other pause re-runs the pending op in recovering mode: the same session plus `recoveryNote` (R1/F4).

---

## 13. CLI, sealed evaluation, skills, bin, doctor (WP7)

### 13.1 `bin/cc-rsi` command reference (`lib/cli/main.mjs`)
```js
export async function main(argv: string[]): Promise<number>     // exit code
```
- Global refusal: if `CC_RSI_ROLE` is set → exit **64** with the `RoleContextError` message (J2-4).
- **Human-only** commands (marked ★) refuse when `CLAUDECODE` is set → exit **65** with `HumanOnlyError` (J2-6). The main guard also denies them to model Bash (§11.8).

```
cc-rsi status [--json] [--session <sid>] [--project <dir>]
cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>★]
cc-rsi memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external★] | restore <N>★ | freeze
              | unfreeze [--after-sealed]★ | export <dir> | import <dir>★ | drafts [--prune★]
cc-rsi explore preflight <start options>
cc-rsi explore start --phase broad|deep|frozen [--direction TEXT|--direction-file F] [--target TEXT|--target-file F]
              [--target-conditioned] [--fixtures DIR] [--id ID] [--model M] [--actor-model M] [--verifier-model M]
              [--curriculum-model M] [--escalation-model M] [--summarizer-model M] [--allow-unconfined] [--skip-auth-probe]
              [--foreground] [--yes] [--session <sid>]
cc-rsi explore status [<id>] [--json] | log <id> [--follow] [-n N] | stop <id> | resume <id> [--accept-drift] [--foreground]
              | abandon <id>★ | show <id> | list
cc-rsi eval run <lineage> [--retries N] [--json-out PATH]★ | eval show <lineage> [--run R]★
cc-rsi verify cancel [--session <sid>]★     (kill the running interactive job gracefully; the job's finally-restore runs; infra 'cancelled')
cc-rsi gc [--older-than DAYS] [--dry-run] [--streams]
cc-rsi engine run <lineageDir>              (internal; = daemon.mjs)
cc-rsi version
```
- Options may appear anywhere after the subcommand.
- `explore start` without `--yes` prints the preflight (plan + blockers) and `re-run with --yes to launch`, then exits 0. This replaces RSIAgent's ACK tokens with an explicit confirmation.
- Exit codes: 0 ok, 1 error, 2 usage, 3 refused by a blocker, 64 role context, 65 human-only.
- `explore status` and `list` never print report text or scores.
- `explore log` prints protocol events in one-line form.
- `explore show` lists contexts (role, key, session id, resolved model, invocations, last class) and, per context, `claude --resume <sid> --fork-session` to inspect it **without mutating** it (PN §4.10).

Every `lib/cli/<cmd>.mjs` exports `export async function run(args: string[], io = { stdout, stderr, env, cwd, isTTY }): number`. `main.mjs` exports `main(argv)` and `parseArgs(argv, spec) → { positionals, options }` (no dependency; `--key value`, `--key=value`, `--flag`).

### 13.2 `bin/cc-rsi` (CommonJS shim) and the `<home>/bin` shim (`lib/cli/shim.mjs`)
```js
#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
if (Number(process.versions.node.split('.')[0]) < 18) { process.stderr.write('cc-rsi requires Node >= 18\n'); process.exit(1); }
if (process.env.CC_RSI_ROLE) { process.stderr.write('cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)\n'); process.exit(64); }
import(pathToFileURL(path.join(__dirname, '..', 'lib', 'cli', 'main.mjs')).href)
  .then((m) => m.main(process.argv.slice(2)))
  .then((code) => { process.exitCode = typeof code === 'number' ? code : 0; },
        (err) => { process.stderr.write(String((err && err.stack) || err) + '\n'); process.exitCode = 1; });
```
`package.json` has no `"type"`. `test/plugin/bin.test.mjs` runs `bin/cc-rsi version` on the current Node, and on every `node18`, `node20` or `node22` found on PATH.
```js
export async function writeShim(home, pluginRoot): boolean   // <home>/bin/cc-rsi, 0755, only when content differs:
// #!/bin/sh
// # Generated by cc-rsi SessionStart; points at the plugin root of the most recent Claude Code session.
// exec node "<pluginRoot>/bin/cc-rsi" "$@"
```

### 13.3 Skills (exact files). Every skill calls `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi"` (J2-10)

`skills/status/SKILL.md`:
```markdown
---
name: status
description: Show cc-rsi state for this project — memory size and integrity, frozen/sealed flags, the current task's independent-verification state, and running or paused exploration lineages. Never shows sealed evaluation scores.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status --session ${CLAUDE_SESSION_ID}`

Summarise the status above for the user in a few short lines. Do not run further commands.
```
`skills/explore/SKILL.md`:
```markdown
---
name: explore
description: Start, inspect, pause or resume cc-rsi exploration lineages — Phase 1 broad waves, Phase 2 deep target/practice, Phase 3 frozen attempts — which run in the background as headless Claude Code children.
argument-hint: "preflight|start|status|log|stop|resume|show|list … (e.g. start --phase broad --direction-file ideas.md --yes)"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore $ARGUMENTS --session ${CLAUDE_SESSION_ID}`

Report the output above to the user faithfully. If it is a preflight, tell the user to re-run with --yes to launch. Do not poll; the user can run /cc-rsi:explore status later.
```
`skills/memory/SKILL.md`:
```markdown
---
name: memory
description: Inspect the cc-rsi project memory (inventory, history, integrity). Read-only.
argument-hint: "show [path] | inventory | history | verify"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory $ARGUMENTS`

Relay the output to the user.
```
`skills/freeze/SKILL.md`: `disable-model-invocation: true`. Body: `` !`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze` `` then "Tell the user memory is now frozen (Phase-3 reuse); unfreezing is human-only: run `cc-rsi memory unfreeze` in a terminal."

`skills/doctor/SKILL.md`: `disable-model-invocation: true`, `argument-hint: "[--live]"`. Body: `` !`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" doctor $ARGUMENTS --session ${CLAUDE_SESSION_ID}` `` then "Explain each FAIL/WARN and its remedy."

Human-only subcommands refuse inside `!` injection too, because `CLAUDECODE=1` is set there. That is intended: unfreeze, eval, restore and the rest have no skill.

### 13.4 Sealed evaluation (`lib/sealed/eval.mjs`; dsh `host/sealed.ts` + RSIAgent grading lifecycle)
```js
export async function runSealedEvaluation({ home, projectRoot, lineageId, retries, jsonOut, stdout = process.stdout }): { status, runId }
export async function showEvaluation({ home, projectRoot, lineageId, runId, stdout }): void   // prints the score only to a TTY
```
1. **Refuse** when:
   - `CLAUDECODE` or `CC_RSI_ROLE` is set;
   - `evaluation.command` (global-only argv) is empty;
   - the lineage has no `result.json`, is not `deep`/`frozen`, or lacks `candidate_digest`;
   - its engine lock is live.
2. The source is `priv/final-candidate/tree`. `treeFingerprint(source)` must equal `candidate_digest`; otherwise refuse with "the final candidate changed after the lineage ended".
3. Store: `freeze({by:'eval'})` if not frozen, then `assertFrozenIntact()`. Record `memory_tree_before`.
4. `runId = 'r-YYYYMMDDhhmmss'`. Copy the source → `<P>/sealed/<lineage>/<runId>/candidate`. Write `task.md` (the lineage target text).
5. Run the argv with `cwd` = the candidate copy and `env` = `childEnv` allowlist (no `CC_RSI_*`, no `CLAUDE*` session variables) + `RSI_CANDIDATE_ROOT` + `RSI_TASK_FILE`, under `timeoutSec`.
   - Exit 0 → `score` = the last non-empty stdout line parsed as a JSON number or `{"score": n}`. Unparseable → `blocked`.
   - Non-zero exit or timeout → retry up to `retries` times. The same stderr-tail sha `identicalErrorLimit` (3) times in a row → `blocked` early (RSIAgent `GradingBlocked`).
6. Re-hash memory, `assertFrozenIntact()`, then `store.markSealed({lineage, runId})`.
7. Write `evaluation.json` (snake_case):
   ```json
   {"schema_version": 1, "lineage": "…", "run_id": "r-…", "status": "scored" | "blocked", "score": 0.83 | null,
    "attempts": [{"exit_code": 0, "timed_out": false, "stdout_tail": "…", "stderr_tail": "…", "duration_ms": 1234}],
    "candidate_digest": "…", "memory_tree_before": "…", "memory_tree_after": "…", "frozen_intact": true,
    "official_evaluator_feedback_entered_agent": false, "ts": "…"}
   ```
   Also write `<lineageDir>/sealed.json` `{runs:[runId]}` (no score).
8. Print the score only when `stdout.isTTY`. Otherwise print `evaluation recorded (score withheld: stdout is not a terminal); view it with "cc-rsi eval show <lineage>" in a terminal`. `--json-out PATH` writes the evaluation summary to a user-chosen file.

**Phase ordering.**
- With `sealed.json` present in the store, these refuse: `learn`, `memory_commit`, `explore start broad|deep`, and resume of learning lineages.
- `cc-rsi memory unfreeze --after-sealed` (human-only) is the only way back. It sets `learningAfterSealed:true`, and later `result.json` files carry `learning_after_sealed_evaluation: true` (RSIAgent `_ensure_no_later_phase`).

The model is kept away from scores in three ways:
- The main guard denies Bash `cc-rsi … eval` and every file tool under `<home>`.
- Roles have `<home>/projects` hidden.
- `status` shows only counts.

### 13.5 `doctor` (`lib/cli/doctor.mjs`). Each check prints `PASS|WARN|FAIL <name>: <detail> [→ remedy]`
1. Node ≥ 18.
2. `claude` resolved; version ≥ 2.1.295; `missingFlags` empty.
3. git available. WARN otherwise: change facts and staleness digests degrade.
4. `<home>` writable, mode 0700, local filesystem.
5. Store:
   - recovery ran;
   - tamper → FAIL `→ cc-rsi memory verify --accept-external | restore <N>`;
   - frozen intact;
   - pending commit resolved;
   - abandoned drafts listed.
6. Locks:
   - stale workspace locks;
   - `restoreFailed` → FAIL `→ inspect <displaced dir>, then cc-rsi doctor --release-lock <root>` (human-only; `LeaseLock.forceRelease`).
7. Lineages whose `state.status=running` but whose engine is dead → WARN `→ cc-rsi explore resume <id>`.
8. Sandbox: static probe; with `--live`, the live probe.
9. Hooks active for `--session` (`requests.jsonl` exists) → else WARN.
10. MCP: spawn `mcp/server.mjs`, `initialize` + `tools/list` → 5 tools.
11. Models: the resolved Verifier vs session/actor model. WARN when equal (RSIAgent's cross-model asymmetry is off by default).
12. `--live` (costs ≤ 2 tiny calls):
    - (a) **auth probe**: a child with the exact role flags, env and forwarded settings, `--tools ""`, stdin "Reply with the single word OK." → expect class `reply`;
    - (b) **hook probe**: the same invocation's guard log has the `prompt` pass entry, else FAIL `hooks_not_run`;
    - (c) the sandbox live probe when static passes.
13. Config warnings (unknown keys, ignored project keys).

### 13.6 `gc`
Removes:
- attestations older than 1 h;
- for sessions with `endedAt` older than N days (default 14): views, checkpoints, `displaced/` and ctx invocation logs;
- `<home>/vscratch/<sid>` of retired or closed tasks older than N days;
- `<home>/work/<key>/<id>` of terminal lineages;
- with `--streams`, `stream.jsonl` of terminal lineages.

Records (task.json, verdicts, journals, results) are never deleted.

### 13.7 Manifests (exact)
`.claude-plugin/plugin.json` (no `version`, so installs track commits; no component path keys, so the default `skills/`, `hooks/hooks.json`, `.mcp.json` and `bin/` are used):
```json
{
  "name": "cc-rsi",
  "displayName": "cc-rsi — recursive self-improvement",
  "description": "RSIAgent-style recursive self-improvement for Claude Code: an independent headless Verifier for your work, Actor-owned verified experience memory, and background Curriculum-driven exploration lineages (broad waves, deep target/practice, frozen reuse with sealed evaluation).",
  "author": {"name": "mutsuki14", "url": "https://github.com/mutsuki14"},
  "homepage": "https://github.com/mutsuki14/CC-RSI",
  "repository": "https://github.com/mutsuki14/CC-RSI",
  "license": "Apache-2.0",
  "keywords": ["self-improvement", "verifier", "memory", "curriculum", "rsi", "rsiagent"],
  "userConfig": { "…": "§14.1 verbatim" }
}
```
`.claude-plugin/marketplace.json`:
```json
{"name": "cc-rsi", "owner": {"name": "mutsuki14", "url": "https://github.com/mutsuki14"},
 "description": "Single-plugin marketplace for cc-rsi.",
 "plugins": [{"name": "cc-rsi", "source": "./", "description": "Independent Verifier, verified experience memory and exploration lineages for Claude Code (after RSIAgent)."}]}
```
Install:
- From a shell: `claude plugin marketplace add mutsuki14/CC-RSI && claude plugin install cc-rsi@cc-rsi`.
- In a session: `/plugin marketplace add mutsuki14/CC-RSI`, then `/plugin install cc-rsi@cc-rsi`.
- Local development: `claude --plugin-dir /path/to/CC-RSI`.

---

## 14. Configuration

### 14.1 Plugin `userConfig` (`.claude-plugin/plugin.json`). Kept to 3 keys; `options` needs ≥ 2.1.271
```json
"userConfig": {
  "verifier_model": {"type": "string", "title": "Verifier model",
    "description": "Alias (opus, sonnet, haiku, fable) or full model id for the independent Verifier. Empty: the session's model.", "default": ""},
  "stop_policy": {"type": "string", "title": "Stop policy", "options": ["off", "nudge", "gate"], "default": "nudge",
    "description": "off: never remind. nudge: remind once before finishing unverified or unlearned work. gate: block finishing unverified work up to 3 times."},
  "sandbox": {"type": "string", "title": "OS sandbox for role children", "options": ["auto", "require", "off"], "default": "auto",
    "description": "auto: use the Claude Code sandbox when it works, otherwise degrade explicitly (shown at session start). require: refuse to run Verifier and lineage children without it. off: never use it."}
}
```
**Delivery.**
- MCP: `${user_config.*}` in `.mcp.json` env (defaults substituted [V E9]) → `CC_RSI_OPT_*`.
- Hooks: `CLAUDE_PLUGIN_OPTION_VERIFIER_MODEL|STOP_POLICY|SANDBOX`, present only when the user saved a value [V E5]. Otherwise the code default applies.
- `${user_config.*}` is **never** used in hook args (J1-6).
- `test/plugin/defaults.test.mjs` asserts the manifest defaults equal `DEFAULTS` (`models.verifier: ''`, `interactive.stopPolicy: 'nudge'`, `isolation.sandbox: 'auto'`).

### 14.2 JSON config (`<home>/config.json` global; `<projectRoot>/.claude/cc-rsi.json` project)
Precedence: CLI flags > non-empty userConfig > project (restricted, see below) > global > `DEFAULTS`.
- **G** = honoured only from the global file or CLI. A project value is ignored with a warning, which prevents repository-planted code execution or weaker isolation.
- **T** = tighten-only from the project file (§5.2).

| Key | Default | Notes |
|---|---|---|
| `mode` | `"learn"` | `"frozen"` = Phase-3 reuse (also implied by store `frozen.json`) |
| `models.actor/verifier/curriculum/summarizer` | `""` | `""`/`"inherit"` = resolution chain §10.3; summarizer `""` → the actor model |
| `models.escalation` | `""` | `""` = no escalation |
| `effort.actor/verifier/curriculum/summarizer` | `""` | `--effort` when set |
| `interactive.enabled` | `true` | `false` makes all tools refuse with a pointer |
| `interactive.taskMessages` | `3` | 1–16 |
| `interactive.waitSeconds` | `100` | 10–110 (J2-12) |
| `interactive.allowUnverified` | `true` | |
| `interactive.verifierIdleHours` | `24` | after this a fresh Verifier context with prior reports |
| `interactive.stopPolicy` | `"nudge"` | `off`/`nudge`/`gate` |
| `interactive.stopGateMax` | `3` | |
| `interactive.baseline` | `true` | S0 baseline at task open |
| `interactive.rewake` | `true` | async rewake hook |
| `interactive.checkpointMaxBytes / checkpointMaxFiles` | `268435456 / 20000` | detect-only above |
| `isolation.sandbox` **T** | `"auto"` | `off` < `auto` < `require` |
| `isolation.allowUnconfined` **G** | `false` | lineages without a sandbox (J2-9) |
| `isolation.verifierNetwork` **T** | `[]` | sandbox `allowedDomains`; the project file may only remove entries |
| `isolation.actorNetwork` **T** | `[]` | same |
| `isolation.foreignMessageGuard` **G** | `true` | the UserPromptSubmit digest filter |
| `isolation.verifierBashDeny` **G** | `true` | mutation patterns for non-sandboxed Verifiers |
| `transport.actionlessLimit / ceiling` | `3 / 24` | RSIAgent 3 |
| `transport.pauseSecs / pauseMaxSecs` | `30 / 300` | transient backoff |
| `transport.pauseCeilingSecs` | `{interactive: 1800, lineage: 21600}` | |
| `transport.retryWatchdog` | `true` | `CLAUDE_CODE_RETRY_WATCHDOG=1` |
| `transport.watchdogMaxWaitMs` | `{interactive: 1800000, lineage: 21600000}` | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` |
| `transport.turnTimeoutSec` | `{actor: 14400, verifier: 14400, interactiveVerifier: 7200, curriculum: 14400, summarizer: 600}` | |
| `transport.maxTurns` | `{actor: 2000, verifier: 2000, curriculum: 2000, summarizer: 1}` | `--max-turns` |
| `transport.maxBudgetUsdPerMessage` | `0` | `--max-budget-usd` when > 0 |
| `transport.compaction` | `{practiceActor: "off", targetActor: "auto", verifier: "off", curriculum: "off"}` | §10.12 |
| `transport.livenessNotes` | `true` | role PostToolUse REPEAT note |
| `exploration.waveConcurrency` | `2` | 1–8 (RSIAgent released 4) |
| `exploration.waveCeiling` | `16` | disclosed only when exceeded |
| `exploration.broadProjectBudget` | `12` | checked only between waves |
| `exploration.deepPracticeBudget / targetCycleBudget` | `6 / 6` | `0` = unbounded (RSIAgent) |
| `exploration.unverifiedRounds / targetResumes / branchRetries / frozenRepairRounds` | `3 / 1 / 1 / 8` | |
| `exploration.stopPolicy` | `"curriculum_review"` | or `"verifier_pass"` |
| `exploration.curriculumMemoryAccess` | `"read_only"` | `"none"` (Phase-2 ablation) |
| `exploration.escalationHandoverReports` | `false` | RSIAgent: no handover |
| `exploration.synthesizeWorklog` | `true` | summarizer + strategy review |
| `exploration.webTools` **T** | `false` | WebFetch/WebSearch for lineage Actors |
| `exploration.maxCostUsd` | `0` | `0` = off; checked at boundaries → `budget_exhausted` |
| `exploration.modelMayStart` **G** | `false` | the main guard denies model Bash `cc-rsi explore start\|resume` |
| `memory.dir` **G** | `""` | store root override |
| `memory.maxFiles / maxTotalBytes / maxFileBytes` | `400 / 4194304 / 65536` | |
| `memory.keepHistory` | `true` | |
| `memory.promptInventory` | `40` | inventory lines |
| `audit.sealedTextFiles` **G** | `[]` | held-out task texts / grader sources |
| `audit.shingleWords` | `8` | min 3 |
| `evaluation.command` **G** | `[]` | argv |
| `evaluation.timeoutSec / retries / identicalErrorLimit` **G** | `900 / 2 / 3` | |
| `children.claudeBin` **G** | `""` | |
| `children.envPassthrough` **G** | `[]` | extra env names or `PREFIX_*` |
| `children.keepStreams` | `true` | keep `stream.jsonl` per invocation |

`DEFAULTS` in `lib/core/config.mjs` is exactly this table as a nested object (dotted keys → nesting). Values are validated by type and range. An out-of-range value reverts to the default with a warning.

---

## 15. Testing

Run with `node scripts/run-tests.mjs`. It walks `test/` for `*.test.mjs`, excludes `test/e2e` unless `CC_RSI_E2E=1`, and runs `node --test <files…>`. Explicit file lists avoid Node 18's "every .js file in a test dir" rule.
- Every test uses a temp `CC_RSI_HOME` (`test/_helpers/tmp.mjs`) and never touches `~/.cc-rsi`.
- No test needs network or a real `claude`, except `test/plugin/validate.test.mjs` (skipped when `claude` is absent) and `test/e2e` (opt-in).

### 15.1 Shared helpers (owned as marked; their APIs are fixed here)
```js
// test/_helpers/tmp.mjs  [WP1]
export async function tmpDir(prefix = 'cc-rsi-test-'): string            // auto-removed at process exit
export async function tmpHome(): { home, env }                            // env = {...process.env, CC_RSI_HOME: home} minus CC_RSI_ROLE/CLAUDECODE
export async function gitRepo(files = {}): string                         // temp git repo with an initial commit of `files`
// test/_helpers/spawn.mjs  [WP1]
export async function runNode(script, args = [], { stdin = '', env, cwd, timeoutMs = 20000 } = {}): { code, stdout, stderr }
// test/_helpers/fake.mjs  [WP4]
export async function fakeClaude({ scenario /* abs path of a scenario module */, home }): { env, bin, log: () => object[], reset() }
   // env adds CC_RSI_CLAUDE_BIN=<repo>/test/fake-claude/claude, FAKE_CLAUDE_HOME (session store), FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_LOG
```

### 15.2 Fake `claude` contract (`test/fake-claude/claude` + `claude.mjs`, WP4). WP5 and WP6 depend on it.

**Invocation surface.**
- `--version` → `2.1.296 (Claude Code)`. `--help` → a text containing every `REQUIRED_FLAGS` entry.
- Requires `-p`. It parses exactly the flags of §10.2 plus `--include-hook-events`. An unknown flag → stderr `error: unknown option '<x>'`, exit 1.
- The prompt is stdin. **Any positional argument → exit 2** with stderr `FAKE: positional prompt`.
- **Forbidden env** (any `NEVER` name of §10.5 present) → exit 3, stderr `FAKE: forbidden env <NAME>`.
- Missing `CC_RSI_ROLE`, `CC_RSI_EXPECT` or `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` → exit 3.

**Sessions** (`$FAKE_CLAUDE_HOME/sessions/<id>.json` = `{id, cwd, turns:[{prompt, text, actions}], pendingInterrupted}`).
- `--session-id` with an existing id → R4: no stdout, stderr `Error: Session ID <id> is already in use.`, exit 1.
- `--resume` with an unknown id → R3: one stdout line `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"<id>","errors":["No conversation found with session ID: <id>"]}`, exit 1.

**Settings.** The fake reads `--settings` JSON. **Hooks run** for real (spawn `command` + `args`, stdin = the payload JSON, honouring `timeout`) unless `FAKE_CLAUDE_RUN_HOOKS=0`:
- UserPromptSubmit fires with `{session_id, transcript_path, cwd, hook_event_name, prompt, permission_mode:'dontAsk'}`.
  - On `decision:block` → emit the **F7 shape**: `system/init`, a `system/informational` "UserPromptSubmit operation blocked by hook: … Original prompt: <prompt>", a `result` with `is_error:false`, `num_turns:0`, `result:"UserPromptSubmit operation blocked by hook: …"`, exit 0.
- PreToolUse fires per scripted action whose tool is in `--tools`, with `{…, tool_name, tool_input, tool_use_id:'toolu_fake_<n>'}`.
  - deny → tool_result `is_error` "PreToolUse:<Tool> hook error: <reason>"; the tool is not executed.
  - `permissionDecision:"allow"` → the fake records `allowSeen:true` in its log (tests assert the role guard never does this).
  - Matchers follow Claude Code rules (`*`/empty = all; an exact `|` list; otherwise an unanchored regex).
- PostToolUse fires after an executed tool. Its `additionalContext` is recorded in the session history.
- SessionStart `compact` fires when the scenario returns `compact:true`. Its `additionalContext` is recorded in the history.

**Tools.** A scripted action whose tool is not in `--tools` → tool_result "No such tool available: <Tool>" without hooks. Otherwise, permissions:
- `dontAsk`: a tool is permitted iff the settings `allow` contains the bare tool name, or `Edit(//abs/**)` covers the path (for Write/Edit), and no `deny` rule matches (`Read(//abs/**)` prefix match).
- A denied tool → tool_result error plus a `permission_denials` entry.
- `--restricted`: file-tool paths outside cwd + `permissions.additionalDirectories` → denied.

**Effects**: Bash runs via `/bin/sh -c` in cwd with the child env (30 s timeout). Write/Edit/Read touch the real filesystem.

**Scenario** (`$FAKE_CLAUDE_SCENARIO`, an ES module): `export default async function respond(ctx)` with `ctx = {role: env.CC_RSI_ROLE, sessionId, turn /* 1-based per session */, prompt, history, cwd, env, flags, recovering: /HARNESS RECOVERY/.test(prompt)}`. It returns one of:
```js
{ actions?: [{ tool: 'Bash', command } | { tool: 'Write', file_path, content } | { tool: 'Edit', file_path, old_string, new_string }
             | { tool: 'Read', file_path } | { tool: 'Glob'|'Grep', pattern, path }], text: string, stopReason?: 'end_turn'|'max_tokens',
  compact?: boolean, model?: string, initOverride?: { mcp_servers?, tools?, permissionMode? } }
{ apiError: { status: 404|429|529|401|413, error: 'model_not_found'|'rate_limit'|'overloaded'|'authentication_failed'|'context_length_exceeded', text? } }  // F3 shape
{ resultSubtype: 'error_max_turns'|'error_during_execution'|'error_max_budget_usd' }
{ crash: 'before-init'|'after-init'|'mid-tool'|'after-result', exit?: number, stderr?: string }   // 'mid-tool': emit tool_use, then exit 137;
                                                   // the next --resume shows history entry {interrupted:true} (R1)
{ hangMs: number }                                 // sleep (killable by SIGINT/SIGTERM → exit 130/143 without a result)
{ stderrOnly: string, exit: number }               // e.g. 'Error: sandbox required but unavailable: …' (f2)
```
**Stream output** (with `--output-format stream-json --verbose`):
- `system/init` `{cwd, session_id, tools: parsed --tools, mcp_servers: [], model: flags.model ?? 'fake-default-model', permissionMode, claude_code_version:'2.1.296'}`;
- per action: one `assistant` event (`message.id = msg_<turn>_<k>`, one `tool_use` block) and, with `--include-hook-events`, `system/hook_started`/`hook_response`; then a `user` tool_result event;
- one final `assistant` text event;
- `result` `{type:'result', subtype:'success', is_error:false, result: text, session_id, num_turns: actions+1, total_cost_usd: cumulative (0.001 per action + 0.001), stop_reason, terminal_reason:'completed', permission_denials}`.

`--max-turns N` with more actions than N → `result.subtype:'error_max_turns'`. Every invocation is appended to `$FAKE_CLAUDE_LOG` as `{argv, cwd, envKeys, ccRsi:{CC_RSI_*}, stdinSha, sessionId, mode:'new'|'resume', exit, allowSeen, hooksRun:[…]}`.

### 15.3 Suites (owner → files → what each asserts)

| WP | File | Asserts |
|---|---|---|
| 1 | `test/memory/hash.test.mjs` | all §6.1 vectors; `f4d20f37…` never produced; invalid entries rejected; `manifestSha256` ASCII/non-ASCII/astral |
| 1 | `test/memory/store.test.mjs` | ported dsh `memory.test.ts`: conflict; limits at commit; condense allowed; freeze blocks drafts and detects mutation; symlink refused; audit quarantine absorbing (inventory unchanged); crash between renames recovers; pending marker with and without install; half-opened drafts never reopen; torn journal tail tolerated; lock takeover (dead pid, same-pid predecessor, expired lease); idempotent commit by episode/origin; **tamper detection** (external write → `MemoryTamperError`, `acceptExternal`, `restoreHistory`); `rebaseDraft` keeps `.prev`; sealed refusal; external draft dir sweep by owner liveness; report re-hash |
| 1 | `test/memory/{safe-path,tree,audit,inventory,view}.test.mjs` | dsh cases (`'' /etc/passwd ../escape a/../../b C:/x`); pycache drop; non-UTF-8 name rejection; brace names omitted; view read-only modes |
| 1 | `test/core/{config,lock,atomic,jsonl,paths,proc}.test.mjs` | precedence; GLOBAL_ONLY ignored from the project file with a warning; tighten-only (`off` from the project cannot loosen `auto`; network intersection); torn-tail JSONL; lease semantics; `killGracefully` order SIGINT→SIGTERM→SIGKILL |
| 2 | `test/protocol/tokens.test.mjs` | fences (both kinds, a longer closing fence, unterminated), indentation, emphasis tolerance, blockquote rejected, identical repeats OK, conflicts invalid, UNVERIFIED gating, DECISION body after the token line, STATUS body |
| 2 | `test/protocol/{wave,leads}.test.mjs` | dsh wave rules (last fenced block, ids, `<PROJECT_ROOT>`, SATURATED with projects invalid, ceiling detail); CLAIM/PROBE (fenced, inline fence, unterminated never swallows, heredoc/backslash rejected, `<<<` allowed, ≤ 16); `formatLeads` exact text |
| 2 | `test/prompts/render.test.mjs` | strict placeholders; goldens; forbidden-string scan; every template used; `bundleSha` stable; snapshot rendering |
| 3 | `test/workspace/checkpoint.test.mjs` | restore never deletes pre-existing, ignored or unreadable files; displaced copies kept; created files moved, not deleted; detect-only above caps without buffering; persisted checkpoint restorable by a new process |
| 3 | `test/workspace/git.test.mjs` | planted `filter`/`diff`/`textconv`/`fsmonitor`/hooks never run; system-scope `safe.directory` honoured; `statusDigest` changes on a same-size content edit (mtime) and is null outside git; `projectRoot` shared by worktrees |
| 3 | `test/workspace/{fixtures,fingerprint,baseline,copy}.test.mjs` | shape gate details; capture/replay exact set; read-only view; fingerprint covers `.git`, modes and symlink targets; baseline delta text |
| 4 | `test/runtime/argv.test.mjs` | golden argv per role; no positional prompt; `--session-id` only on the first send; `--tools` last; never forbidden flags |
| 4 | `test/runtime/env.test.mjs` | against a snapshot of this container's env (EXP §f list) plus a passthrough attempting `CLAUDE_CODE_SESSION_ID`: no NEVER name survives; PATH loses the cc-rsi bins; SET values present |
| 4 | `test/runtime/stream-classify.test.mjs` | the real fixtures `test/fixtures/streams/f1-run1.jsonl` → reply with 3 actions; `f3-run3.jsonl` → `config` (the text is never used); `f7-run10.jsonl` with a guard log containing a `block` entry → `isolation_violation`; with no guard entries → `hooks_not_run`; with `attestation = {hooksRan:true, promptBlocked:false}` → `no_reply` (row 21), so `result.result` is never parsed; `r3-run3.jsonl` → `session_missing`; R4 stderr → `session_conflict`; f2 stderr → `sandbox_unavailable`; one synthetic fixture per remaining row of §10.8 |
| 4 | `test/runtime/context.test.mjs` (fake claude) | transient 529 then success → `TRANSPORT_PAUSE` + recovery note embedding the message, same session; `pauseCeiling` → `transient_exhausted`; watchdog → `timeout` and the child killed; abort → `InterruptedError`; `sandbox_unavailable` + degrade → re-run without the sandbox block; `hooks_not_run` when `FAKE_CLAUDE_RUN_HOOKS=0`; guard gaps are warn-only; a tool absent from `--tools` is never a gap |
| 4 | `test/runtime/converse.test.mjs` | continues while acting; 3 actionless → `TransportInfraError(transport_liveness)`; ceiling; a valid publication wins even when actionless; truncation not counted; an override resets and sends the stall continuation |
| 4 | `test/guard/role-guard.test.mjs` | spawns `hooks/role-guard.mjs` with synthetic payloads: digest pass/block; hidden path deny incl. `..` through a symlink; search root above a hidden root; write outside writeRoots; Bash hidden tokens, allowedPaths masking, recursion (`claude`, `cc-rsi`, `node …/bin/cc-rsi`, `npx @anthropic-ai/claude-code`), mutation patterns; **property test**: 500 random payloads never yield `allow`; malformed input → deny; guard log written before output; REPEAT liveness note; pin |
| 5 | `test/hooks/*.test.mjs` | spawn `hooks/hook.mjs <sub>` with payloads built from the EXP §a key sets (`test/hooks/payloads/*.json`): SessionStart JSON shape, ≤ 9000 chars, systemMessage content, shim written, compact pin; UPS synthetic filter, requests capture, task open after PASS, baseline spawn; guard: lock deny for main and for an `agent_id` payload, private-path deny, view/draft allow, human-only Bash deny, `explore start` deny; attest file contents + role deny; Stop matrix (each row, `stop_hook_active`, gate cap, `background_tasks`); `CC_RSI_ROLE` no-op; malformed stdin exits 0; timing p95 < 150 ms for guard/attest |
| 5 | `test/mcp/protocol.test.mjs` | spawn the server: `server/discover` → -32601 with the same id; initialize negotiation; `tools/list` names, schemas, `_meta`; ping; unknown notification ignored; -32700; -32600 for a batch; stdout carries JSON-RPC only; `CC_RSI_ROLE` → every tool isError |
| 5 | `test/interactive/flow.test.mjs` (fake claude + real server + real job) | attestation required; subagent refused; submit → PASS; FAIL → repair → second inspection uses `--resume <same V>` and generation 2; UNVERIFIED → only LEAD blocks reach the Verifier's stdin (an Actor-narrative sentinel is absent); RUNNING after a short `waitSeconds` then `wait_verdict`; the lock denies Bash in a second session; the Verifier mutates and creates files → restored with displaced copies + HARNESS NOTE; job SIGKILLed mid-run → recovery restores + `job_died` infra; infra never sets a verdict; learn wrong/right confirm codes; conflict path; frozen/sealed/tamper refusals; stale PASS → learn refused; verdict files are not writable through the guard |
| 6 | `test/engine/journal.test.mjs` | replay returns recorded results; divergence throws; recovering flag; overrides; nested ops; blobs; concurrent prefixes |
| 6 | `test/engine/broad.test.mjs` | two waves then SATURATED; budget stops at a wave boundary (overshoot allowed); serial consolidation in **authored order** on the latest canonical; a missing fixture tree → same Curriculum context continuation; a branch infra (crash) → unscored restart with `-a2` and an `infra_attempts` receipt; a non-retryable infra → wave paused, **no commits**, resume completes; quarantine on an audit hit is absorbing; Actor memory is absent from the Verifier cwd tree and deleted before inspection |
| 6 | `test/engine/deep.test.mjs` | FAIL → practice → mandatory fresh target → PASS + READY → `verifier_pass_curriculum_ready`; `verifier_pass` policy; STALLED → exactly one final test; target stall → escalated Actor `--model <esc>` + **new** Verifier `--model <original actor>` with **no** prior reports in its charter; practice budget → final target `budget_exhausted`; distill → reconcile → diagnosis order; over-limit draft condensed by the same Actor; UNVERIFIED never learned; practice UNVERIFIED exhaustion → pause → resume override → one more round |
| 6 | `test/engine/frozen.test.mjs` | FAIL → same-Actor repair with the same Verifier context; no learning; memory hash unchanged; frozen tamper → infra |
| 6 | `test/engine/crash-matrix.test.mjs` | for each N in 1..(op count of a reference broad and deep run): (a) throw at op N, (b) SIGKILL the engine at op N, (c) SIGKILL **and mutate the workspace** (touch a file in the target root, delete an authoring dir) before resume. Then `explore resume` until terminal. Assert `result.json` (minus ts and cost), the memory `tree_sha256` and the journal episode list are equal to the uninterrupted run, and no episode is committed twice. Plus: the R3 path on a first-message crash (new uuid, no R4) |
| 7 | `test/sealed/eval.test.mjs` | scores a copy on frozen memory with a fake evaluator; refused under `CLAUDECODE`; refused on a changed candidate; `blocked` after retries and after identical stderr ×3; the score is not printed when stdout is not a TTY; the sealed marker blocks learning |
| 7 | `test/cli/*.test.mjs` | role refusal (64); human-only refusal (65) under `CLAUDECODE`; `explore start` without `--yes` → preflight; unconfined blocker without `--allow-unconfined`; status never prints report text; `explore show` prints `--fork-session` hints; shim content |
| 7 | `test/plugin/{manifest,defaults,boundaries,bin,validate}.test.mjs` | `plugin.json`/`marketplace.json` shape; userConfig defaults == DEFAULTS; import boundaries (§3); the CJS bin runs on available Nodes; `claude plugin validate . --strict --json` → `success:true` (skipped without `claude`) |
| 7 | `test/e2e/smoke.test.mjs` (`CC_RSI_E2E=1`, real `claude`, `--model haiku`, allowlisted env, temp git repo) | (1) `cc-rsi doctor --live` → auth + hook probes PASS. (2) `claude -p --plugin-dir <repo> --model haiku` "Create hello.txt containing hi. When done call the cc-rsi submit tool; if it says VERIFICATION RUNNING call wait_verdict until you have a verdict; reply with the verdict line." Assert a verdict record (not infra), `isolation` recorded, the workspace restored, no `--session-id` reuse. (3) `cc-rsi explore start --phase broad --direction "tiny text-processing CLI exercises" --allow-unconfined --foreground --yes --model haiku` with `broadProjectBudget:1, waveCeiling:1` → termination ∈ {budget_exhausted, saturated}, a journal commit with tree hashes, `official_evaluator_calls: 0`. (4) SIGTERM a second broad lineage mid-wave, then `explore resume` completes. (5) freeze + `cc-rsi eval run` with `evaluation.command = ["sh","-c","echo 1"]` and `--json-out` |

---

## 16. Remaining differences from RSIAgent

1. **No VM; isolation is narrower.**
   - Without bubblewrap/socat (this container, WSL1) the role children are confined only by `--restricted` file tools, permission rules, a heuristic Bash guard, and checkpoint/restore of tracked and untracked-not-ignored files.
   - Bash read-hiding, network egress control and process isolation are **heuristic or absent**.
   - RSIAgent uses QEMU rollback, namespaces and a private tmpfs scratch.
   - The sandbox, when present, wraps Bash only. Hooks, MCP and Claude Code itself run unsandboxed.
   - Every record states the mode actually used. Lineages require an explicit `--allow-unconfined` without a sandbox.
2. **Same OS user.** The Actor (the user's session) and every role share one uid. Forgery or reading by obfuscated Bash is possible. The guards stop accidents and casual access; tamper detection (§6.6) and report re-hashing **detect** canonical-memory and report changes. Neither prevents a determined adversary.
3. **Rollback scope.**
   - Interactive restore covers git-listed plus untracked-not-ignored files under the candidate root, and is detect-only above 256 MiB / 20 000 files.
   - Lineage restore covers the whole project root.
   - Processes, services, databases, `.git` internals (interactive) and anything outside the root are not rolled back. The Verifier is told so, and the external-service rule is kept verbatim.
4. **Interactive mode is an extension.** RSIAgent has no interactive mode.
   - The Actor is the user's session with the user's permissions, and may skip `submit`. The Stop hook only nudges or gates.
   - Every terminal interactive verdict may be learned (`kind:"task"`).
   - The authoritative task is the last N captured user messages (text only), not one immutable instruction.
   - The interactive Verifier sees no images or attachments.
5. **Evidence leads are `NOT_RUN`; there is no done-check gate.** RSIAgent validates and **executes** the Actor's checks (`core/checks.py`) and classifies leads PASS/FAIL. cc-rsi never executes model-authored probes outside a role child (J1-3), so the gate and the classification are absent.
6. **Handoff by final message.** It replaces handoff files, the `verifier-report` Program and `learning_diagnosis.md`. Publication is not atomic with an action. Dry or actionless assistant turns stay in the context: Claude Code cannot drop them, so there is no "semantic replay".
7. **Transport recovery adds a user turn** (a recovery note embedding the original message; F4/R1). RSIAgent retries the unchanged request invisibly. The in-child `CLAUDE_CODE_RETRY_WATCHDOG` keeps 429/529 retries invisible up to its cap.
8. **Compaction.** The target and frozen Actors use Claude Code auto-compaction with a re-pinned verbatim task instead of RSIAgent's fold summarizer. Other roles are lossless, and an overflow is infra. Claude Code's context window is smaller than RSIAgent's ~900k assumptions.
9. **Ceilings.** Iteration ceilings map to per-invocation `--max-turns` plus wall watchdogs. A Claude Code "turn" is not exactly an RSIAgent iteration. Deep budgets default to 6/6 (RSIAgent: unbounded under `curriculum_review`), `waveCeiling` is 16, and `waveConcurrency` is 2 (RSIAgent released 4). Exhaustion always ends `budget_exhausted`, never as convergence.
10. **Recovery is operator-triggered and generic.** `explore resume` uses pure admission plus the op journal and continues the same sessions with a recovery note. RSIAgent uses incident-specific, operator-authored plans with hash-chain admission. A lost transcript (pruned after `cleanupPeriodDays`) pauses a lineage as `context_lost`.
11. **Practice replay is a copy on the same host.** Parallel branches share one machine, so Bash could observe siblings: they are hidden only heuristically, or mechanically with a sandbox.
12. **No cross-model asymmetry by default.** Every role inherits the session model unless configured. `doctor` and SessionStart warn when Verifier = Actor. Escalation and the asymmetric swap work only when `models.escalation` is set.
13. **Exam fence reduced.** It keeps the 8-word shingle tripwire over memory commits, Curriculum handoffs, notes, fixtures and role assistant text. There is no constant-tuple or path rule, no task-id regex, no live egress probe and no evaluator-source quarantine scan.
14. **Phase transitions.** There is no protocol JSON spanning phases and no ACK tokens (replaced by `--yes` preflight). Ordering is enforced per store: frozen blocks learning lineages; sealed blocks learning until an explicit, recorded `unfreeze --after-sealed`. A Phase-1 `stalled` does not block Phase 2.
15. **Not ported:**
    - the witness gate, visual split ledger and doubt escalation;
    - Look ensembles (Claude Code Read gives native vision);
    - `FIDELITY_NOTE`;
    - the LIVENESS cycle observation (only REPEAT is ported);
    - unified-loop routers (HANDOFF/VERIFY_MORE, REVISE/EVOLVE; not wired in the released protocol either);
    - the optional Verifier orientation stage.
16. **Memory is per project** (git common dir), not per lineage root. Interactive learning and lineages share one store, serialized by the store lock and conflict-checked by base hash.
17. **Role transcripts** live in `~/.claude/projects/<cwd-slug>/`. Interactive Verifier sessions share the user's project slug and may appear in session pickers. They are hidden from the Actor only by the guard.
18. **POSIX only.** There is no native Windows support. The `bin/` directory makes the plugin ineligible for claude.ai/Cowork distribution, which is not a target.

---

## 17. Verify early in implementation (each item has a fallback; record the outcome in `docs/ARCHITECTURE.md`)

| # | Item | Probe | Fallback |
|---|---|---|---|
| V1 | `asyncRewake` PostToolUse on an MCP tool wakes an idle interactive session | e2e manual check; hook log | `wait_verdict` (already the contract) |
| V2 | A main-session PreToolUse `allow` for Read outside cwd suppresses the prompt in `default` mode | manual interactive check | `doctor` prints an allow rule `Read(~/.cc-rsi/projects/*/views/**)` for the user to add |
| V3 | `onFailure:"block"` is honoured for `--settings` hooks under `--restricted` | a guard script that exits 1 | the guard prints deny on any exception; `hooks_not_run` covers silence |
| V4 | The role UserPromptSubmit hook fires on **`--resume`** invocations (F6 verified the first message) | runtime test against the real binary (doctor `--live` sends two messages) | if not: switch hook attestation to a PreToolUse heartbeat and keep the digest guard best-effort — **must be resolved before release** |
| V5 | SessionStart(`compact`) from `--settings` fires in `-p` children | long-context smoke | inject `taskPin` into the next continuation after a compact boundary is seen in the stream |
| V6 | The stream-json event name for compaction | observe once | do not record compaction |
| V7 | Skill `!` injection with a quoted `"${CLAUDE_PLUGIN_ROOT}"` command matches the quoted `allowed-tools` rule | manual | unquoted command + rule (paths without spaces), documented |
| V8 | `_meta["claudecode/toolUseId"]` is present (E9) | `test/e2e` + doctor MCP check | fail closed with the `doctor` message |
| V9 | PostToolUse `tool_response` shape for MCP tools (rewake parsing) | hook log | rewake searches the JSON string; no wake otherwise |
| V10 | sandbox `denyWrite:[cwd]` + `allowWrite:[scratch]` is effective | `doctor --live` | correctness unaffected: restore always runs |
| V11 | `--setting-sources ""` + `--restricted` + `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` hide the project CLAUDE.md | e2e marker | add `--disable-slash-commands` (already) and rely on `--restricted` |
| V12 | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` accepted on 2.1.296 | env-vars doc says ≥ 2.1.295 | the cc-rsi backoff still bounds pauses |

---

## 18. Work packages (disjoint file ownership; build in parallel against §5–§15)

**Rules for all packages.**
- Code only against the interfaces in this document. If an interface is missing something, add a backward-compatible optional parameter and note it in the PR. Never change a documented signature.
- Unit tests for your own modules must not import another package's internals. Integration tests (WP5/WP6/WP7) use the real modules once merged; until then they may skip with `test.skip` when a dependency module is absent (`import()` in a try).
- Use the dsh-rsi sources at `/home/user/mutsuki14/dsh-rsi/src` as the reference implementation wherever a section says "port". Strip the TypeScript types, use `.mjs`, avoid parameter properties, and keep behaviour and texts.
- Cite RSIAgent or dsh line references in comments where behaviour is ported.
- English only in code, comments and prompts. No emojis. Node ≥ 18. Zero dependencies.

| WP | Title | Owns (exclusively) | Consumes |
|---|---|---|---|
| WP1 | Core primitives + memory store | `lib/core/*`, `lib/memory/*`, `test/core/*`, `test/memory/*`, `test/_helpers/tmp.mjs`, `test/_helpers/spawn.mjs` | — |
| WP2 | Protocol parsing + prompts | `lib/protocol/*`, `lib/prompts/*`, `prompts/*.md`, `test/protocol/*`, `test/prompts/*` | §5 (digest, errors) |
| WP3 | Workspace: copy, safe git, checkpoint, fixtures, fingerprint, baseline | `lib/workspace/*`, `test/workspace/*` | §5 |
| WP4 | Headless runtime, role guard, fake claude | `lib/runtime/*`, `lib/guard/*`, `hooks/role-guard.mjs`, `test/fake-claude/**`, `test/_helpers/fake.mjs`, `test/fixtures/streams/*`, `test/runtime/*`, `test/guard/*` | §5, §6.1 (`canonicalJson`), §8.2 (`recoveryNote`, builders used in tests) |
| WP5 | Interactive mode: MCP server, hooks, verification job | `lib/interactive/*`, `lib/mcp/*`, `lib/hooks/*`, `hooks/hook.mjs`, `hooks/hooks.json`, `mcp/server.mjs`, `.mcp.json`, `test/interactive/**`, `test/hooks/**`, `test/mcp/*` | §5, §6, §7, §8.2 (guidance, actorProtocol, verifier builders), §9, §10.9–10.11, §13.2 (`writeShim`), §15.2 |
| WP6 | Exploration engine (journal, phases, resume) | `lib/engine/*`, `test/engine/**` | §5, §6, §7, §8.2, §9, §10, §15.2 |
| WP7 | CLI, sealed evaluation, skills, packaging, plugin tests, e2e | `lib/cli/*`, `lib/sealed/*`, `bin/cc-rsi`, `skills/**`, `.claude-plugin/*`, `package.json`, `scripts/run-tests.mjs`, `test/cli/*`, `test/sealed/*`, `test/plugin/*`, `test/e2e/*` | §5, §6, §9, §10.1/10.4/10.11 (probes), §11.1 (session files), §12.2/12.4/12.15 (`preflight`, `createLineage`, `runEngine`, `admitResume`, `applyResume`, `abandon`, `showLineage`) |
| WP8 | Documentation | `README.md`, `README.zh.md`, `docs/ARCHITECTURE.md`, `NOTICE`, `LICENSE` | the whole spec |

### WP1 — Core primitives + memory store
- Implement §5 exactly.
- Port dsh `src/memory/{hash,paths,audit,store}.ts`, with these changes:
  - UTF-8 key ordering in `canonicalJson`;
  - `manifestSha256`;
  - external draft dirs with owner liveness;
  - `pullTree` rules;
  - tamper detection (`expectedTreeHash`, `assertCanonicalIntact`, `acceptExternal`, `restoreHistory`);
  - sealed marker;
  - `rebaseDraft`;
  - `inventory.json`;
  - `auditTexts` writing `audit_rejects.jsonl` without content.
- Also `view.mjs` and `inventory.mjs`.
- Port dsh `test/memory.test.ts` to `node:test` and add the §6.1 vectors and the §15.3 WP1 rows.
- Acceptance:
  - all vectors pass, including `20b3f2cc…`;
  - kill-between-renames recovery works;
  - lock takeover works across two Node processes (`test/_helpers/spawn.mjs`).

### WP2 — Protocol parsing + prompts
- Implement §7 (port dsh `src/protocol/{tokens,wave}.ts` and the leads code in `src/engine/steps.ts`) with the cc-rsi changes:
  - unique standalone tokens anywhere in prose;
  - emphasis tolerance;
  - DECISION body after the token line;
  - only `NOT_RUN` lead classification.
- Write every template in §8.3 from the listed sources in `scratchpad/analysis/prompts/` (the dsh texts are the closest base; `dsh-rsi/src/roles/*.ts` holds the live builders), applying rules A1–A6.
- Implement `render.mjs` (strict placeholders, snapshotting) and all builders in §8.2. Each builder is a thin composition of templates.
- Produce goldens and the forbidden-string test.
- Acceptance:
  - every builder renders;
  - goldens are reviewed;
  - no forbidden strings;
  - every template is used.

### WP3 — Workspace
- Implement §9 by porting dsh `src/host/git.ts`, `src/host/checkpoint.ts`, `src/engine/fixtures.ts` and `src/engine/workspace.ts`.
- Additions:
  - displaced-copy restore (move, never delete);
  - a persisted checkpoint (`entries.json`) restorable from another process;
  - `statusDigest`;
  - `projectRoot` via `--git-common-dir`;
  - `contentDelta`;
  - `baseline.mjs` with its CLI entry;
  - `copy.mjs` without `fs.cp`.
- Port dsh `test/isolation.test.ts` (checkpoint, git) plus the §15.3 WP3 rows.
- Acceptance: planted git drivers never execute; restore never deletes pre-existing or ignored files.

### WP4 — Headless runtime, role guard, fake claude
- Implement §10 (all subsections) and §15.2 (fake claude), `test/_helpers/fake.mjs`, and the stream fixtures.
- **Stream fixtures**: copy these into `test/fixtures/streams/`, replacing the absolute scratch paths with `/tmp/fixture`:
  - `scratchpad/exp-fid/out/run1.jsonl` → `f1-run1.jsonl`;
  - `run3.jsonl` + `run3.err` → `f3-run3.*`;
  - `run10.jsonl` → `f7-run10.jsonl`;
  - `scratchpad/exp-robust/logs/run3.jsonl` + `.err` → `r3-run3.*`;
  - `run4.err` → `r4-run4.err`.
- `hooks/role-guard.mjs` imports only `lib/core` and `lib/guard`. It must start in < 80 ms.
- Acceptance:
  - the classification table is covered row by row;
  - the role guard never emits `allow` (property test);
  - argv goldens;
  - env NEVER list enforced;
  - `RoleContext` transient, degrade, R3 and watchdog paths pass against the fake.

### WP5 — Interactive mode
- Implement §11 entirely: session and task state, attestation, the verification job (run + recover), workspace locks, the memory view, the hooks dispatcher and every hook, `hooks.json` and `.mcp.json` verbatim, and the MCP server (JSON-RPC, 5 tools, progress, cancellation, waits ≤ 110 s).
- Tool descriptions and server `instructions` per §11.11.
- Hooks must meet the §11.8 budgets and import boundaries (§3). The job uses `RoleContext` + `converse` from WP4 and `Checkpoint` from WP3.
- Acceptance: §15.3 WP5 rows, incl. the full fake-claude flow (submit → FAIL → repair → `--resume` same Verifier → PASS → learn → commit), and lock/restore/displaced behaviour.

### WP6 — Exploration engine
- Implement §12 entirely: `OpJournal` with the determinism rules, records/admission/abandon/show, the daemon with signals and pause states, `EngineContext`, journaled converse and free phases, both protected inspections, `learnOp`, `targetAttempt` (deep + frozen), worklog synthesis, `runProject`/`runProjectWithRetry`, broad/deep/frozen.
- Port dsh `src/engine/lineage.ts` state machines faithfully, with the cc-rsi changes listed in §12 (unscored restart attempt naming, pause instead of fail, the escalation swap without handover by default, Phase-3 same-Actor FAIL repair, Actor memory removed before inspection, live target inspection under checkpoint).
- Port dsh `test/engine.test.ts` scenarios to the fake claude and add the crash matrix.
- Acceptance: §15.3 WP6 rows; the crash matrix is green for the reference broad and deep runs, including the workspace-mutation variant.

### WP7 — CLI, sealed evaluation, skills, packaging
- Implement §13 and §14.1 manifests: the CLI with human-only and role refusals, the CJS bin, `writeShim`, `doctor` (with `--live`), `gc`, sealed evaluation, the five skills verbatim, `plugin.json`/`marketplace.json`, `package.json` (no `type` field), and `scripts/run-tests.mjs`.
- Plugin tests: manifest, defaults parity, import boundaries, bin on available Nodes, `claude plugin validate . --strict --json`.
- The opt-in e2e smoke (§15.3).
- Acceptance: `claude plugin validate . --strict` passes on 2.1.296; the e2e smoke passes with `--model haiku` in this container (with `--allow-unconfined`).

### WP8 — Documentation
- `README.md` (English) and `README.zh.md` (Chinese, same structure). Contents:
  - what cc-rsi is (RSIAgent mechanisms in Claude Code);
  - install (marketplace and `--plugin-dir`);
  - the everyday flow (submit/wait_verdict/learn/memory_commit; Stop policy);
  - exploration lineages (`/cc-rsi:explore …`, CLI, `--allow-unconfined`, resume);
  - Phase 3 (freeze, frozen lineage, terminal-only sealed eval);
  - configuration (userConfig + config tables);
  - isolation honesty (the sandbox/rollback/unconfined meanings, with a highlighted warning that without a sandbox the Verifier and lineage children run Bash unattended);
  - the `~/.cc-rsi` layout and `gc`;
  - troubleshooting (`doctor --live`; auth forwarding);
  - remaining differences (§16, summarised);
  - credits.
- `docs/ARCHITECTURE.md`: §1–§2 decisions and trust boundaries, the state machines (task, job, lineage phases), the invariants (infra ≠ verdict; readiness ≠ correctness; sealed isolation; memory only through commits), the module map, §16 in full, and a "verify-early outcomes" table (§17) for implementers to fill in.
- `NOTICE` credits:
  - RSIAgent (Sibo Zhu, Shicheng Fan, Xinyue Wang, Wenyi Wu, Kun Zhou, Biwei Huang. "RSIAgent: Autonomous Exploration for Recursive Self-improvement in New Environments." arXiv:2609.15364, 2026; https://github.com/AetherLabsAI/RSIAgent; Apache-2.0);
  - dsh-rsi (https://github.com/mutsuki14/dsh-rsi; Apache-2.0), stating which files adapt their prompts and algorithms.
- `LICENSE`: the Apache-2.0 text.

### Integration order (single-branch merge; packages are independent until here)
1. WP1.
2. WP2, WP3, WP4.
3. WP5, WP6.
4. WP7.
5. WP8 last, updated with the actual verify-early outcomes.

After the merge, run `npm test`, `claude plugin validate . --strict`, and `CC_RSI_E2E=1 npm test` (smoke).
