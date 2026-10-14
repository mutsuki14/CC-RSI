# cc-rsi

English | [中文](README.zh.md)

**Recursive self-improvement for Claude Code.** cc-rsi is a Claude Code plugin that ports the benchmark-independent mechanisms of [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (arXiv:2609.15364), by way of the earlier port [dsh-rsi](https://github.com/mutsuki14/dsh-rsi):

- **An independent Verifier for your everyday work.** When Claude finishes a non-trivial task it calls `submit`. A separate headless `claude -p` process inspects the live workspace against your own recent messages, never Claude's reasoning, and returns `PASS`, `FAIL` or `UNVERIFIED` with a report. The workspace is checkpointed before the inspection and restored after it.
- **Actor-owned, verified experience memory.** After a terminal verdict Claude can distill reusable procedures, scripts, environment facts and failure lessons into a per-project memory. Memory changes only through an atomic, journaled two-step commit. Every later session gets a read-only view of it.
- **Exploration lineages in the background.** A detached engine runs RSIAgent's Phase 1 (broad Curriculum-authored waves), Phase 2 (deep target/practice) and Phase 3 (frozen reuse) with headless Actor, Verifier and Curriculum children. Every step is journaled, so a crash, stop or infrastructure failure pauses the lineage and `resume` continues it.
- **Sealed evaluation.** An optional evaluator command scores a lineage's final candidate from a terminal only. The score never reaches a model context.

Model weights never change. All improvement comes from verified experience carried across tasks in memory.

Design and trust boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Normative specification: [docs/design/SPEC.md](docs/design/SPEC.md).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Everyday use](#everyday-use)
- [Exploration lineages](#exploration-lineages)
- [Phase 3: freeze, frozen lineages, sealed evaluation](#phase-3-freeze-frozen-lineages-sealed-evaluation)
- [Configuration](#configuration)
- [Isolation: what is and is not protected](#isolation-what-is-and-is-not-protected)
- [Command-line reference](#command-line-reference)
- [The ~/.cc-rsi directory and gc](#the-cc-rsi-directory-and-gc)
- [Troubleshooting](#troubleshooting)
- [Versions and updates](#versions-and-updates)
- [Development](#development)
- [Remaining differences from RSIAgent](#remaining-differences-from-rsiagent)
- [Credits and citation](#credits-and-citation)

## Requirements

| Requirement | Notes |
|---|---|
| Claude Code ≥ 2.1.295 | Role children depend on hook `onFailure`, which needs 2.1.295. Developed and tested on 2.1.296. `cc-rsi doctor` checks the version and every required CLI flag. |
| Node.js ≥ 18 on `PATH` | Hooks, the MCP server and the CLI run with `node`. No npm dependencies. |
| git | Used for change facts, checkpoints and verdict staleness. Without git these degrade (`doctor` warns). |
| POSIX | macOS, Linux or WSL2. Native Windows is not supported. |
| OS sandbox (optional) | Linux: `bubblewrap` and `socat` on `PATH`. macOS: `/usr/bin/sandbox-exec` (built in). WSL1 cannot sandbox. Without it, read [Isolation](#isolation-what-is-and-is-not-protected). |

## Install

Inside Claude Code:

```
/plugin marketplace add mutsuki14/CC-RSI
/plugin install cc-rsi@cc-rsi
```

or in one step:

```
/plugin install cc-rsi --marketplace mutsuki14/CC-RSI
```

From a shell:

```sh
claude plugin marketplace add mutsuki14/CC-RSI && claude plugin install cc-rsi@cc-rsi
# plugin options can be set at install time, e.g.
claude plugin install cc-rsi@cc-rsi --config verifier_model=opus --config sandbox=require
```

For local development or testing a checkout without installing it:

```sh
claude --plugin-dir /path/to/CC-RSI
```

Start a new session after installing, then run `/cc-rsi:doctor` to check the setup.

**Terminal command.** Every session start refreshes a shim at `~/.cc-rsi/bin/cc-rsi` that points at the plugin of the most recent session. Add it to your `PATH` once:

```sh
export PATH="$HOME/.cc-rsi/bin:$PATH"
```

Without the shim, run `node /path/to/CC-RSI/bin/cc-rsi …`. Human-only commands (sealed evaluation, unfreeze, restore, abandon, …) work only from a terminal.

## Everyday use

There is nothing to start. Work with Claude as usual; the plugin's hooks add the RSI protocol to the session.

### What you see

At session start a status line such as:

```
cc-rsi: Verifier isolation = rollback (sandbox unavailable: bubblewrap (bwrap) not installed, socat not installed); Verifier model = inherit; memory 12 files (learn)
```

It is followed by `; WARNING: Verifier model equals the session model` when the Verifier would run on the same model as your session, and by a warning when memory was changed outside a commit.

When a non-trivial task is done, Claude calls the cc-rsi `submit` tool and you see the verdict it receives:

```
cc-rsi · Verifier: VERDICT: FAIL (generation 1, isolation=rollback, model=claude-…)
<the Verifier's report, verbatim>
<guidance for Claude>
```

The loop:

```
your request → Claude works (it may read the memory view)
  → submit             checkpoint the workspace; a detached job starts a headless Verifier
                       that sees your last 3 messages (text only) and the live workspace;
                       Claude's edits and shell commands in that workspace are paused
  → PASS | FAIL | UNVERIFIED, with the report; the workspace is restored
       FAIL        Claude repairs and calls submit again; the SAME Verifier session is resumed
                   and told what changed since its last inspection
       UNVERIFIED  Claude may resubmit with evidence_leads (CLAIM/PROBE pairs); the Verifier
                   receives them as leads to check itself; the harness never runs them
  → learn              after PASS or FAIL: a draft copy of memory opens for distillation
  → memory_commit      (with the 6-hex code from the stage message) reconciliation stage
  → memory_commit      (new code) atomic promote: journaled with tree hashes before and after
```

A `submit` or `wait_verdict` call waits up to about 100 s. If the Verifier needs longer, the result says `VERIFICATION RUNNING (job …)`. Claude then calls `wait_verdict`; an asynchronous hook also tries to wake the session when the verdict lands. File reads stay allowed while a verification runs.

### The MCP tools (server `rsi`)

| Tool | Purpose | Who may call it |
|---|---|---|
| `submit` | Start (or join) an independent verification of the current workspace. Optional `evidence_leads: [{claim, probe}]`, used only after an `UNVERIFIED` verdict (at most 16). | Main conversation only |
| `wait_verdict` | Wait for and receive a running or undelivered verdict. | Main conversation only |
| `learn` | After `PASS` or `FAIL`, open a learning phase on a draft of the project memory. | Main conversation, `mode: learn` |
| `memory_commit` | `{confirm: "<code>"}` advances the learning phase (reconcile, then promote); `{confirm, abandon: true}` discards the draft. | Main conversation, learning open |
| `status` | Session and project state (read-only). | Main conversation and subagents |

Each state-changing call must be attested by the plugin's PreToolUse hook for the same `tool_use_id`. Without active hooks, `submit` refuses and starts nothing. Subagents of the main session are refused.

### Stop policy

The Stop hook (`stop_policy`) reminds Claude before it finishes when a verification is still running, a learning phase is open, the workspace changed with no current verdict covering it, or a verified result has not been learned.

- `nudge` (default): remind once per condition.
- `gate`: block finishing up to 3 times per prompt (`interactive.stopGateMax`).
- `off`: never remind.

A verdict is *current* only while the git status digest of the workspace equals the one recorded at inspection. A stale `PASS` does not count, and `learn` refuses a stale verdict.

### Skills

| Skill | What it does |
|---|---|
| `/cc-rsi:status` | Memory size and integrity, frozen/sealed flags, the current task's verification state, lineages. Never shows scores. Claude may also invoke it. |
| `/cc-rsi:explore …` | Exploration lineages (next section). User-invoked only. |
| `/cc-rsi:memory …` | `show [path]`, `inventory`, `history`, `log`, `verify`. User-invoked only. |
| `/cc-rsi:freeze` | Freeze memory for Phase 3. User-invoked only. |
| `/cc-rsi:doctor [--live]` | Diagnostics. User-invoked only. |

There is deliberately no skill for unfreezing, restoring, abandoning or sealed evaluation: those run only in a terminal.

## Exploration lineages

A lineage is a detached Node engine. It runs one `claude -p` process per role message, resuming the same session for each role context, and records every side effect in a memoized op journal. Records live in `~/.cc-rsi/projects/<key>/lineages/<id>/`; role working directories live in `~/.cc-rsi/work/<key>/<id>/`.

| Phase | RSIAgent | What happens | Terminations |
|---|---|---|---|
| `broad` | Phase 1 | A Curriculum authors a wave of independent practice projects and their input fixture trees. The harness captures them and replays each into a fresh project root. Branches run in parallel (`waveConcurrency`, default 2) from the same memory snapshot, each with a fresh Actor and a fresh Verifier. After the wave barrier, each Actor distills in its own context, serially in authored order, on the latest memory. A branch that fails on infrastructure restarts unscored from its immutable fixtures. | `saturated`, `stalled`, `budget_exhausted` |
| `deep` | Phase 2 | A fresh Actor attempts the unchanged target. `PASS` or `FAIL` ends the attempt and the same Actor learns from it, writing a diagnosis for the Curriculum. `UNVERIFIED` asks for evidence leads. A stall gets one forced inspection, then one fresh-context resume with a synthesized work log (optionally on an escalation model, with a one-time Verifier swap). The Curriculum then chooses practice projects (`DECISION: PROJECT`), `READY_FOR_TARGET` or `STALLED`. Any practice forces a fresh target attempt; `STALLED` buys exactly one final target test. | `verifier_pass`, `verifier_pass_curriculum_ready`, `verifier_pass_curriculum_stalled`, `curriculum_stalled_final_target_test`, `target_harness_unverified`, `budget_exhausted` |
| `frozen` | Phase 3 | One target attempt on frozen memory. `FAIL` sends the report back to the same Actor for repair (up to `frozenRepairRounds`, default 8). No learning, no Curriculum. | `frozen_attempt_complete`, `target_harness_unverified` |

Any phase can also end `quarantined` (the leakage tripwire fired) or `abandoned`. Infrastructure failures are never terminal: the lineage pauses as `paused_infra` and `resume` continues it.

### Starting a lineage

`start` without `--yes` prints the preflight: the plan, the models, the isolation mode and any blockers. Nothing is launched. Re-run with `--yes`. The lineage id defaults to `<phase>-<UTC timestamp>`; `--id` sets it.

In Claude Code:

```
/cc-rsi:explore start --phase broad --direction-file ideas.md
/cc-rsi:explore start --phase broad --direction-file ideas.md --yes
```

In a terminal:

```sh
cc-rsi explore start --phase broad --direction "small text-processing CLI tools" --yes
cc-rsi explore start --phase deep --target-file task.md --fixtures ./inputs --yes
```

- `broad` needs `--direction` / `--direction-file`, or a target with `--target-conditioned`. `deep` and `frozen` need `--target` / `--target-file`. `--fixtures DIR` is captured immutably at start.
- `--model M` sets the Actor, Verifier and Curriculum models. `--actor-model`, `--verifier-model`, `--curriculum-model`, `--escalation-model` and `--summarizer-model` set one role each. Unset roles follow `models.*` in the config, then the session model (when started from a session), `ANTHROPIC_MODEL`, `model` in `~/.claude/settings.json`, and finally Claude Code's default. The resolved models are recorded in `lineage.json`.
- **Without an OS sandbox, `start` is refused** unless you pass `--allow-unconfined` (or set `isolation.allowUnconfined: true` in `~/.cc-rsi/config.json`). See [Isolation](#isolation-what-is-and-is-not-protected). Prefer a disposable container or VM.
- At launch one tiny model call checks that role children can authenticate (`--skip-auth-probe` skips it).
- `--foreground` runs the engine in the current process instead of detaching it.
- Claude itself cannot start or resume lineages from its Bash tool (unless the global `exploration.modelMayStart` is `true`).

### Following and controlling a lineage

```sh
cc-rsi explore list                     # ids, phases, statuses
cc-rsi explore status [<id>] [--json]   # counters, cost, isolation, pause reason; never report text or scores
cc-rsi explore log <id> [--follow] [-n N]
cc-rsi explore show <id>                # role contexts with `claude --resume <sid> --fork-session` hints
cc-rsi explore stop <id>                # SIGTERM; the engine stops its children and pauses (paused_user)
cc-rsi explore resume <id> [--accept-drift] [--foreground]
cc-rsi explore abandon <id>             # human-only; records termination "abandoned"
```

`resume` first runs a write-free admission check. It refuses a terminal lineage, a live engine, tampered memory, a frozen or sealed store for a learning lineage, or changed plugin code (pass `--accept-drift` to accept the change). Depending on where the lineage paused, it grants one more continuation (liveness pause), one more evidence round (practice `UNVERIFIED` exhaustion) or four more commit attempts (commit ceiling); every other pause re-runs the interrupted step in the same role sessions.

`result.json` uses RSIAgent's snake_case keys (`termination`, `target_verifier_verdict`, `curriculum_decision`, `candidate_digest`, tree hashes, `official_evaluator_calls: 0`, …) so it can be compared with RSIAgent records.

## Phase 3: freeze, frozen lineages, sealed evaluation

1. **Freeze memory**: `/cc-rsi:freeze` or `cc-rsi memory freeze`. Interactive `learn` and new `broad`/`deep` lineages are then refused. Unfreezing is human-only: `cc-rsi memory unfreeze` in a terminal.
2. **Run a frozen lineage**: `cc-rsi explore start --phase frozen --target-file task.md [--fixtures DIR] --yes`. The engine checks that the frozen tree is unchanged before and after the attempt.
3. **Configure the evaluator** in `~/.cc-rsi/config.json` (global only, never from a project file):

   ```json
   {"evaluation": {"command": ["python3", "/abs/path/grade.py"], "timeoutSec": 900, "retries": 2}}
   ```

   The command runs with its working directory set to a fresh copy of the lineage's final candidate, an allowlisted environment, and `RSI_CANDIDATE_ROOT` and `RSI_TASK_FILE` (a file holding the target text). It must print the score as the last line of stdout: a JSON number or `{"score": n}`. A non-zero exit or a timeout is retried; the same error 3 times in a row (`identicalErrorLimit`) records `blocked`.
4. **Evaluate, in a terminal**: `cc-rsi eval run <lineage> [--retries N] [--json-out PATH]`. The lineage must be a finished `deep` or `frozen` lineage whose final candidate is unchanged. The score is printed only when stdout is a terminal; otherwise it is recorded and `cc-rsi eval show <lineage> [--run R]` shows it later, again only on a terminal.

Sealed evaluation freezes memory if it is not frozen, checks the frozen tree before and after, and marks the store sealed. After that, learning stays closed until a human runs `cc-rsi memory unfreeze --after-sealed`; later lineage results then carry `learning_after_sealed_evaluation: true`.

The score is kept away from every model context: `eval` refuses to run inside Claude Code (`CLAUDECODE` is set), Claude's Bash is denied `cc-rsi … eval`, and Claude's file tools are denied everything under `~/.cc-rsi`, apart from the memory view, the shim and an open learning draft. `--json-out` refuses paths inside the project, the work trees and the sealed run directories.

## Configuration

### Plugin options (`userConfig`)

Set them in Claude Code's plugin configuration (`/plugin`) or at install time with `--config key=value`.

| Option | Default | Values |
|---|---|---|
| `verifier_model` | `""` (the session's model) | An alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model id |
| `stop_policy` | `nudge` | `off`, `nudge`, `gate` |
| `sandbox` | `auto` | `auto`: use the Claude Code sandbox when it works, otherwise degrade explicitly. `require`: refuse to run Verifier and lineage children without it. `off`: never use it |

They map to `models.verifier`, `interactive.stopPolicy` and `isolation.sandbox`. Hooks see an option only after you save a value (until then the built-in default applies); the MCP server sees the saved value or the manifest default. A `cc-rsi` command run in a terminal does not see plugin options, so put values that terminal commands need (for example lineage models) in `~/.cc-rsi/config.json`.

### JSON configuration

| File | Scope |
|---|---|
| `~/.cc-rsi/config.json` | Global (all projects) |
| `<project>/.claude/cc-rsi.json` | One project (restricted, see below) |

Precedence, lowest to highest: built-in defaults, global file, project file, non-empty plugin options, command-line flags. Keys can be nested objects or dotted strings (`{"models.verifier": "opus"}`). Unknown keys and invalid values are dropped with a warning (`cc-rsi doctor` lists them); an invalid value falls back to the next lower layer.

- **G** (global only): ignored, with a warning, when it appears in a project file. This stops a cloned repository from planting an evaluator command, extra environment variables or weaker isolation.
- **T** (tighten only): a project file may only make the value stricter (`isolation.sandbox`: `off` < `auto` < `require`; network lists may only lose entries; `webTools` may only be turned off). A stricter project value wins even over plugin options and flags.

| Key | Default | Notes |
|---|---|---|
| `mode` | `"learn"` | `"frozen"`: Phase-3 reuse (also implied by a frozen store) |
| `models.actor` / `verifier` / `curriculum` / `summarizer` | `""` | `""` or `"inherit"`: session model, then `ANTHROPIC_MODEL`, then `model` in `~/.claude/settings.json`, then Claude Code's default. The summarizer falls back to the Actor model |
| `models.escalation` | `""` | Model for a stalled target Actor's fresh-context resume. `""` disables escalation |
| `effort.actor` / `verifier` / `curriculum` / `summarizer` | `""` | Passed as `--effort` when set |
| `interactive.enabled` | `true` | `false`: every tool refuses with a pointer |
| `interactive.taskMessages` | `3` | Recent user messages the Verifier receives (1–16) |
| `interactive.waitSeconds` | `100` | Per-call wait (10–110); also capped by `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` |
| `interactive.allowUnverified` | `true` | Allow the `UNVERIFIED` verdict |
| `interactive.verifierIdleHours` | `24` | After this idle time a fresh Verifier context starts, seeded with prior reports |
| `interactive.stopPolicy` | `"nudge"` | `off` / `nudge` / `gate` |
| `interactive.stopGateMax` | `3` | Blocks per prompt under `gate` |
| `interactive.baseline` | `true` | Snapshot the workspace file state when a task opens |
| `interactive.rewake` | `true` | Async hook that wakes the session when a verdict lands |
| `interactive.checkpointMaxBytes` / `checkpointMaxFiles` | `268435456` / `20000` | Above either limit the checkpoint is detect-only (no restore) |
| `isolation.sandbox` **T** | `"auto"` | `off` / `auto` / `require` |
| `isolation.allowUnconfined` **G** | `false` | Allow lineages without an OS sandbox |
| `isolation.verifierNetwork` **T** | `[]` | Sandbox `allowedDomains` for Verifiers |
| `isolation.actorNetwork` **T** | `[]` | Sandbox `allowedDomains` for lineage Actors |
| `isolation.foreignMessageGuard` **G** | `true` | Role children refuse any prompt not sent by the harness |
| `isolation.verifierBashDeny` **G** | `true` | Mutation deny patterns (git push, curl POST, ssh, …) for unsandboxed Verifiers |
| `transport.actionlessLimit` / `ceiling` | `3` / `24` | Consecutive actionless segments / segments per handoff phase before a liveness pause |
| `transport.pauseSecs` / `pauseMaxSecs` | `30` / `300` | Backoff for transient API errors |
| `transport.pauseCeilingSecs` | `{"interactive": 1800, "lineage": 21600}` | Total transient pause before giving up |
| `transport.retryWatchdog` | `true` | Sets `CLAUDE_CODE_RETRY_WATCHDOG=1` in role children |
| `transport.watchdogMaxWaitMs` | `{"interactive": 1800000, "lineage": 21600000}` | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` |
| `transport.turnTimeoutSec` | `{"actor": 14400, "verifier": 14400, "interactiveVerifier": 7200, "curriculum": 14400, "summarizer": 600}` | Wall-clock watchdog per role message |
| `transport.maxTurns` | `{"actor": 2000, "verifier": 2000, "curriculum": 2000, "summarizer": 1}` | `--max-turns` per invocation |
| `transport.maxBudgetUsdPerMessage` | `0` | `--max-budget-usd` when > 0 |
| `transport.compaction` | `{"practiceActor": "off", "targetActor": "auto", "verifier": "off", "curriculum": "off"}` | `off`: lossless context (overflow is infrastructure); `auto`: Claude Code auto-compaction with the task re-pinned |
| `transport.livenessNotes` | `true` | Warn a role that repeats an identical command with an identical result |
| `exploration.waveConcurrency` | `2` | Parallel branches per wave (1–8; RSIAgent released 4) |
| `exploration.waveCeiling` | `16` | Maximum projects per wave |
| `exploration.broadProjectBudget` | `12` | Checked between waves |
| `exploration.deepPracticeBudget` / `targetCycleBudget` | `6` / `6` | `0` = unbounded (RSIAgent) |
| `exploration.unverifiedRounds` / `targetResumes` / `branchRetries` / `frozenRepairRounds` | `3` / `1` / `1` / `8` | |
| `exploration.stopPolicy` | `"curriculum_review"` | Or `"verifier_pass"`: stop at the first target `PASS` |
| `exploration.curriculumMemoryAccess` | `"read_only"` | Or `"none"` |
| `exploration.escalationHandoverReports` | `false` | Give the swapped Verifier the prior reports (RSIAgent: no) |
| `exploration.synthesizeWorklog` | `true` | Summarizer work log and strategy review for resumes |
| `exploration.webTools` **T** | `false` | WebFetch/WebSearch for lineage Actors |
| `exploration.maxCostUsd` | `0` | `0` = off; checked at boundaries, ends `budget_exhausted` |
| `exploration.modelMayStart` **G** | `false` | Let Claude's Bash run `cc-rsi explore start` or `resume` |
| `memory.dir` **G** | `""` | Override the store root |
| `memory.maxFiles` / `maxTotalBytes` / `maxFileBytes` | `400` / `4194304` / `65536` | Commit limits; an over-limit draft goes back to the same Actor to condense |
| `memory.keepHistory` | `true` | Snapshot memory after every commit |
| `memory.promptInventory` | `40` | Inventory lines shown in the session context |
| `audit.sealedTextFiles` **G** | `[]` | Held-out task texts or grader sources for the 8-word shingle tripwire |
| `audit.shingleWords` | `8` | Minimum 3 |
| `evaluation.command` **G** | `[]` | Sealed evaluator argv |
| `evaluation.timeoutSec` / `retries` / `identicalErrorLimit` **G** | `900` / `2` / `3` | |
| `children.claudeBin` **G** | `""` | `claude` binary for role children (default: the running Claude Code, else `claude` on `PATH`) |
| `children.envPassthrough` **G** | `[]` | Extra environment variable names (or `PREFIX_*`) passed to role children |
| `children.keepStreams` | `true` | Keep `stream.jsonl` for every role invocation |

`CC_RSI_HOME` moves the whole `~/.cc-rsi` directory.

## Isolation: what is and is not protected

Every role child (Verifier, lineage Actor, Curriculum, summarizer) runs as `claude -p` with `--restricted --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk`, an explicit tool list, an allowlisted environment, no MCP servers, and a per-invocation settings file with path rules and a fail-closed role guard hook. On top of that, the isolation mode is recorded in every verdict and lineage record:

| Mode | Used by | Meaning |
|---|---|---|
| `sandbox` | Verifier and lineage children, when an OS sandbox works | Claude Code's sandbox wraps the role's Bash: writes are confined (a Verifier writes only to its scratch directory), hidden paths are unreadable, network is limited to the configured domains (none by default). The interactive workspace is still checkpointed and restored. |
| `rollback` | Interactive Verifier without a sandbox | The Verifier runs Read, Grep, Glob and Bash **unattended** under the guards below, and the workspace is restored from a checkpoint after every inspection. |
| `unconfined` | Lineages without a sandbox, only with `--allow-unconfined` | Actor, Verifier and Curriculum children run Bash **unattended** with only the guards below. A target project root is restored after each Verifier inspection and practice Verifiers inspect a throwaway replay; nothing a role does outside those roots is rolled back. |

> [!WARNING]
> **Without an OS sandbox, the Verifier and every lineage child run Bash commands unattended, with your user account's permissions, protected only by rollback and heuristics.** Claude Code's sandbox needs `bubblewrap` and `socat` on Linux (or `sandbox-exec` on macOS); it is unavailable on WSL1 and in many containers. In that case:
>
> - The interactive Verifier degrades to `rollback` (announced at session start). Rollback restores git-tracked and untracked-not-ignored files under the workspace root. It does **not** undo processes, services, databases, network calls, `.git` internals, ignored files, or anything outside the workspace. Above 256 MiB or 20 000 files it only detects changes.
> - Lineages refuse to start unless you pass `--allow-unconfined`. Run unconfined lineages in a disposable container or VM.
> - The path guards and the Bash scanner are heuristics against accidents and casual access, not a security boundary. Every role runs as your OS user and can read whatever you can read through obfuscated shell commands.
>
> Set `sandbox` to `require` to refuse instead of degrading.

Further limits that hold in every mode:

- The sandbox, when present, wraps Bash only; hooks, Claude Code itself and file tools are governed by permission rules and the role guard.
- Canonical memory and Verifier reports are **tamper-detected**, not tamper-proof: the memory tree hash is compared with the last commit before every sensitive step, and reports are re-hashed on read.
- Role transcripts live in `~/.claude/projects/` like any session. Interactive Verifier sessions share your project's transcript folder and can appear in session pickers; Claude's file tools are denied them only by the guard.

## Command-line reference

```
cc-rsi status [--json] [--session <sid>] [--project <dir>]
cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>*]
cc-rsi memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external*] | restore <N>*
              | freeze | unfreeze [--after-sealed]* | export <dir> | import <dir>* | drafts [--prune*]
cc-rsi explore preflight|start <start options> | status [<id>] [--json] | log <id> [--follow] [-n N]
              | stop <id> | resume <id> [--accept-drift] [--foreground] | abandon <id>* | show <id> | list
cc-rsi eval run <lineage> [--retries N] [--json-out PATH]* | eval show <lineage> [--run R]*
cc-rsi verify cancel [--session <sid>]*
cc-rsi gc [--older-than DAYS] [--dry-run] [--streams]
cc-rsi version | help
```

`*` marks human-only commands: they refuse to run inside Claude Code (exit 65), and Claude's Bash is denied them. Most commands accept `--project <dir>` (default: the current directory's project). Exit codes: 0 ok, 1 error, 2 usage, 3 refused by a blocker, 64 inside a role child, 65 human-only. `cc-rsi help` prints the full usage.

- `memory verify` checks canonical memory against its last commit. If it changed outside a commit, `--accept-external` records the change as a commit and `restore <N>` rolls back to history snapshot `N` (see `memory history`).
- `memory export <dir>` / `import <dir>` copy memory out of and into the store (import is a recorded commit).
- `verify cancel` stops a running interactive verification. The job restores the workspace and records infrastructure `cancelled`, not a verdict.

## The ~/.cc-rsi directory and gc

cc-rsi keeps its state outside every workspace and outside Claude Code's plugin data, so memory survives plugin uninstalls.

```
~/.cc-rsi/
  config.json                    global configuration
  probe.json                     cached sandbox probe
  bin/cc-rsi                     terminal shim
  logs/                          hooks.log, mcp.log, cli.log, jobs.log
  run/                           attestations, workspace locks, content-addressed child settings, prompts and policies
  vscratch/<verifierSessionId>/  interactive Verifier scratch
  work/<key>/<lineage>/          lineage role working directories (role-visible)
  projects/<key>/                one directory per project (<key> = <name>-<12 hex of the root path>)
    store/                       canonical memory, journal, history, reports, frozen/sealed markers
    sessions/<sid>/              task state, captured requests, verification jobs and logs, verdicts,
                                 checkpoints, displaced copies
    views/<sid>/memory/          the read-only memory view given to the main session
    drafts/<episode>/            interactive learning drafts
    lineages/<id>/               lineage.json, state.json, ops.jsonl, events.jsonl, result.json, engine.log, priv/
    sealed/<lineage>/<run>/      sealed evaluation runs (evaluation.json)
```

A project is the git common directory's parent, so all worktrees of a repository share one memory. `memory.dir` (global) moves the store.

`cc-rsi gc [--older-than DAYS] [--dry-run] [--streams]` removes derived and transient data only: attestations older than an hour; views, checkpoints, displaced copies and Verifier invocation logs of sessions that ended more than `DAYS` (default 14) ago; old Verifier scratch of closed or retired tasks; work trees of finished lineages; and, with `--streams`, the invocation streams of finished lineages. Records (task state, verdicts, journals, results, reports, evaluations) are never deleted, and anything a running job, a live engine or a workspace lock may need is kept.

## Troubleshooting

Start with `/cc-rsi:doctor` (or `cc-rsi doctor` in a terminal). Each check prints `PASS`, `WARN` or `FAIL` with a remedy: Node, the `claude` version and required flags, git, `~/.cc-rsi`, memory integrity and pending commits, workspace locks, lineages whose engine died or paused, the sandbox, whether hooks are active in the session, the MCP server's tool list, the models and configuration warnings.

`cc-rsi doctor --live` adds tiny real model calls (two, or three with a sandbox): an authentication probe with the exact role-child flags and environment, a hook probe on the first message and on `--resume`, and a live sandbox probe when the static one passes.

| Symptom | Cause and fix |
|---|---|
| `submit` says it "cannot attest this call" | The plugin's hooks are not running in this session (`disableAllHooks`, `allowManagedHooksOnly`, or the plugin is disabled). Run `/cc-rsi:doctor` in that session; it checks whether the hooks captured your requests. |
| Verification ends `INFRASTRUCTURE: … (auth)` | Role children run with `--restricted`, which ignores your settings files. cc-rsi forwards `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`, `forceLoginOrgUUID` and provider `env` entries from `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), and passes `ANTHROPIC_*`, `AWS_*`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `CLAUDE_CODE_OAUTH_TOKEN`, proxy and CA variables from the environment. Add other variables with `children.envPassthrough`. Confirm with `cc-rsi doctor --live`. |
| `INFRASTRUCTURE: … (config)` | The model name was rejected; check `verifier_model` / `models.*`. |
| Claude's edits are blocked: "an independent verification of this workspace is running" | Expected while a job runs. Claude should call `wait_verdict`; you can cancel with `cc-rsi verify cancel`. |
| "a verification failed to restore the workspace" | The workspace lock is kept on purpose. Inspect the displaced copies under `~/.cc-rsi/projects/<key>/sessions/<sid>/displaced/<job>/`, then run `cc-rsi doctor --release-lock <root>` in a terminal. |
| Claude Code asks permission to read the memory view | The guard pre-approves reads of the view and the open draft, but this is unverified on real Claude Code. Add `Read(~/.cc-rsi/projects/*/views/**)` (and, for learning, `Edit(~/.cc-rsi/projects/*/drafts/**)`) to your permission allow rules. |
| `memory changed outside a commit` | `cc-rsi memory verify` shows the difference. Keep it with `cc-rsi memory verify --accept-external` or roll back with `cc-rsi memory restore <N>`. |
| A lineage is `paused_infra` | `cc-rsi explore status <id>` shows the class and detail. Fix the cause, then `cc-rsi explore resume <id>`. `context_lost` means an Actor or Curriculum transcript is gone (for example pruned by Claude Code's `cleanupPeriodDays`); that context cannot be continued, so abandon the lineage. |
| `resume refused: the plugin changed since the lineage started` | The plugin was updated after the lineage began. Resume with `--accept-drift` to continue on the current code (recorded in `lineage.json`). |

Logs: `~/.cc-rsi/logs/`, `jobs/<job>.log` in the session directory, `engine.log` in the lineage directory, and one directory per role invocation (`prompt.md`, `stream.jsonl`, `stderr.txt`, `guard.jsonl`, `meta.json`) under the `ctx/` folders.

## Versions and updates

`.claude-plugin/plugin.json` carries a `version` (currently `0.1.0`). Claude Code installs and updates by that version, not by commit, so **every release must bump it**; commits pushed without a bump do not reach installed users. `cc-rsi version` prints the version and the plugin root in use. (The specification originally omitted `version` so installs would track commits, but `claude plugin validate --strict` requires it.)

## Development

```sh
npm test                                   # node scripts/run-tests.mjs: every test/**/*.test.mjs except test/e2e
node scripts/run-tests.mjs test/engine     # one directory or file
npm run smoke                              # CC_RSI_E2E=1: real claude, --model haiku, spends tokens
CC_RSI_E2E_FULL=1 npm run smoke            # also the SIGTERM-then-resume lineage scenario
claude plugin validate . --strict          # manifest, hooks, MCP and skills
claude --plugin-dir .                      # try the working tree in a session
```

- Zero runtime dependencies; tests use `node:test` only and never touch `~/.cc-rsi` or the network. Role children are exercised against a fake `claude` (`test/fake-claude/`) that emulates stream-json, session semantics, crashes and real hook execution.
- The engine's crash matrix (`test/engine/crash-matrix.test.mjs`) kills or throws at every journaled op and checks that resume reproduces the uninterrupted result. `CC_RSI_CRASH_LANES=N` bounds its parallelism; `CC_RSI_CRASH_MATRIX=full` also faults at every op start.
- Prompt goldens: after a deliberate prompt change, `CC_RSI_UPDATE_GOLDENS=1 node scripts/run-tests.mjs test/prompts/render.test.mjs`, then review the diff.
- `test/plugin/boundaries.test.mjs` enforces the module import boundaries; only `lib/runtime/child.mjs` may spawn `claude`.

## Remaining differences from RSIAgent

The full list with reasons is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#remaining-differences-from-rsiagent). In short:

1. No VM. Isolation is the Claude Code sandbox when available, otherwise permission rules, heuristic guards and checkpoint restore.
2. All roles share your OS user; guards stop accidents, and tamper detection detects changes rather than preventing them.
3. Rollback covers files under the workspace root only.
4. Interactive mode is an extension: the Actor is your session, it may skip `submit`, and the task is your last few messages.
5. Evidence leads are passed to the Verifier unexecuted; RSIAgent's done-check gate is not ported.
6. Handoffs are the final assistant message, not files.
7. Transport recovery adds a visible recovery note to the role's conversation.
8. Target Actors use Claude Code compaction with a re-pinned task instead of RSIAgent's fold summarizer.
9. Budgets are bounded by default (deep 6/6, wave ceiling 16, concurrency 2).
10. Recovery is a generic `resume` from the op journal, not incident-specific plans.
11. Practice branches share one host.
12. No cross-model asymmetry unless you configure models.
13. The exam fence is reduced to the 8-word shingle tripwire.
14. Phases are ordered per store (freeze, sealed), with `--yes` instead of ACK tokens.
15. Some RSIAgent features are not ported (witness gate, Look ensembles, unified-loop routers, Verifier orientation stage, …).
16. Memory is per project and shared by interactive learning and lineages.
17. Role transcripts live in Claude Code's own transcript folders.
18. POSIX only.

## Credits and citation

cc-rsi ports [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (Apache-2.0) through [dsh-rsi](https://github.com/mutsuki14/dsh-rsi) (Apache-2.0). [NOTICE](NOTICE) lists the adapted files. If you use cc-rsi, please cite RSIAgent:

```bibtex
@misc{zhu2026rsiagentautonomousexplorationrecursive,
      title={RSIAgent: Autonomous Exploration for Recursive Self-improvement in New Environments},
      author={Sibo Zhu and Shicheng Fan and Xinyue Wang and Wenyi Wu and Kun Zhou and Biwei Huang},
      year={2026},
      eprint={2609.15364},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2609.15364},
}
```

## License

[Apache License 2.0](LICENSE).
