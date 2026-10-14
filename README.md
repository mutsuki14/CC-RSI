# cc-rsi

English | [中文](README.zh.md)

**Recursive self-improvement for Claude Code.** cc-rsi is a Claude Code plugin that ports the benchmark-independent mechanisms of [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (arXiv:2609.15364), by way of the earlier port [dsh-rsi](https://github.com/mutsuki14/dsh-rsi):

- **An independent Verifier for your everyday work.** When Claude finishes a non-trivial task it calls `submit`. A separate headless `claude -p` process inspects the live workspace against your own recent messages, never Claude's reasoning, and returns `PASS`, `FAIL` or `UNVERIFIED` with a report. The workspace is checkpointed before the inspection and restored after it.
- **Actor-owned, verified experience memory.** After a terminal verdict Claude can distill reusable procedures, scripts, environment facts and failure lessons into a per-project memory. Memory changes only through an atomic, journaled two-step commit. Every later session gets a read-only view of it.
- **Exploration lineages in the background.** A detached engine runs RSIAgent's Phase 1 (broad Curriculum-authored waves), Phase 2 (deep target/practice) and Phase 3 (frozen reuse) with headless Actor, Verifier and Curriculum children. Every step is journaled, so a crash, stop or infrastructure failure pauses the lineage and `resume` continues it.
- **Sealed evaluation.** An optional evaluator command scores a lineage's final candidate from a terminal only. The score never reaches a model context.

Model weights never change. All improvement comes from verified experience carried across tasks in memory.

Design and trust boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Normative specification: [docs/design/SPEC.md](docs/design/SPEC.md) (it predates the latest round of fixes; where it differs, the code and the architecture document's [recorded deviations](docs/ARCHITECTURE.md#recorded-deviations-from-the-specification) describe the behaviour).

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
- [Known limitations](#known-limitations)
- [Remaining differences from RSIAgent](#remaining-differences-from-rsiagent)
- [Credits and citation](#credits-and-citation)

## Requirements

| Requirement | Notes |
|---|---|
| Claude Code ≥ 2.1.295 | Role children depend on hook `onFailure`, which needs 2.1.295. Developed and tested on 2.1.296. `cc-rsi doctor` checks the version and every required CLI flag. |
| Node.js ≥ 18 on the `PATH` Claude Code sees | Hooks, the MCP server and the CLI run with `node`; without it the hooks fail and the MCP server does not start. No npm dependencies. |
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

**Terminal command.** Human-only commands (sealed evaluation, unfreeze, restore, abandon, lock release, verification cancel, …) work only from a terminal. Every session start refreshes a shim at `~/.cc-rsi/bin/cc-rsi` (`$CC_RSI_HOME/bin/cc-rsi` when `CC_RSI_HOME` is set) that runs the plugin of the most recent session. Put its directory on your `PATH` once, in your shell profile:

```sh
export PATH="$HOME/.cc-rsi/bin:$PATH"
```

Without the shim, run `node "<plugin root>/bin/cc-rsi" …`. An installed plugin lives under `~/.claude/plugins/cache/<marketplace>/cc-rsi/<version>/`; with `--plugin-dir` it is your checkout. A human-only command refused inside Claude Code prints the exact command line to run (`in a terminal, run: …`), with the shim's absolute path when the shim exists and `node <plugin root>/bin/cc-rsi` otherwise. `cc-rsi doctor` (check `shim`) warns when the shim is missing, points at a plugin root that no longer exists, or its directory is not on `PATH`, and prints the `export PATH=…` line to add.

## Everyday use

There is nothing to start. Work with Claude as usual; the plugin's hooks add the RSI protocol to the session.

### What you see

At session start a status line such as:

```
cc-rsi: Verifier isolation = rollback (sandbox unavailable: bubblewrap (bwrap) not installed, socat not installed); Verifier model = inherit (session model not yet known); memory 12 files (learn)
```

On Claude Code 2.1.296 the SessionStart payload carries no model, so cc-rsi reads the session model from the session transcript at the first cc-rsi tool call or Stop and keeps it until the next session start or `/model` (a turn served by another model, such as a plan-mode or fallback turn, does not change it). Only records the running Claude Code process wrote count: after `--resume`, `--continue` or a fork, the earlier process's records (possibly written under another `--model`) are skipped, so in the first turn the model is not yet known and the next Stop records it. Until then an inheriting Verifier shows `inherit (session model not yet known)` and runs on the next model of the chain (`ANTHROPIC_MODEL`, `model` in `~/.claude/settings.json`, Claude Code's default). When the Verifier model and the session model are both known and equal, the line ends with `; WARNING: Verifier model equals the session model`. A warning is also added when memory was changed outside a commit.

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

- **Your messages** are the prompts you typed (UserPromptSubmit `source` `user`, or `sdk` for `-p` runs). Task notifications, teammate and channel messages, slash commands, other machine-injected turns and prompts Claude scheduled for itself (CronCreate, ScheduleWakeup, RemoteTrigger, `/loop`) are never captured, so they never become the Verifier's task. A `source` in the payload is trusted; without one, a teammate or channel message is recognised only in Claude Code's full wrapper, so a prompt of yours that starts with `<channel>` is still yours. A scheduled prompt is recorded only after the scheduling call succeeded; a one-shot prompt is recognised once, and a schedule you deleted, or that fired or expired, no longer hides the same text when you type it. A schedule counts as gone only after a task list showed it and then no longer does: session tasks are judged by the task list Claude Code passes to the Stop hook, durable CronCreate tasks by `<project>/.claude/scheduled_tasks.json`; a schedule no list has shown is recognised until it is deleted or for at most 8 days.
- **The same Verifier session** is resumed only while its transcript is exactly what its last job left (cc-rsi records a fingerprint after every job), the Verifier model is unchanged and it has not been idle longer than `interactive.verifierIdleHours`. Otherwise a fresh Verifier context starts and receives the earlier reports and what changed since the last inspection that published a report (a resumed Verifier hears what changed since the last tree it inspected itself).
- **Processes started before `submit`** (a background Bash task, a dev server) keep running; the pause applies only to Claude's new edits and commands. A change to the candidate during a sandboxed inspection, which the Verifier cannot make, ends the job as infrastructure `candidate_changed_during_inspection` with no verdict. In rollback mode, a `PASS` during which pre-existing files changed (files that were only created do not count, nor do untracked files below `node_modules`, `.venv` and `__pycache__`) is recorded but never counts as current, and the result says so in a NOTE. Stop such processes before `submit`.

A `submit` or `wait_verdict` call waits up to about 100 s (`interactive.waitSeconds`) and stops waiting early enough to answer about 10 s before Claude Code would move it to the background (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, default 120 s, counted from the arrival of the call). If the Verifier needs longer, the result says `VERIFICATION RUNNING (job …)`. Claude then calls `wait_verdict`; an asynchronous hook also tries to wake the session (once per job) when the verdict lands. File reads stay allowed while a verification runs.

### The MCP tools (server `rsi`)

| Tool | Purpose | Who may call it |
|---|---|---|
| `submit` | Start (or join) an independent verification of the current workspace. Optional `evidence_leads: [{claim, probe}]`, used only after an `UNVERIFIED` verdict (at most 16). | Main conversation only |
| `wait_verdict` | Wait for and receive a running or undelivered verdict. | Main conversation only |
| `learn` | After `PASS` or `FAIL`, open a learning phase on a draft of the project memory. While a phase is open, `learn` re-shows the current stage message and its confirmation code. | Main conversation, `mode: learn` |
| `memory_commit` | `{confirm: "<code>"}` advances the learning phase (reconcile, then promote); `{abandon: true}` discards the draft and needs no code. | Main conversation, learning open |
| `status` | Session and project state (read-only). | Main conversation and subagents |

Each state-changing call must be attested by the plugin's PreToolUse hook for the same `tool_use_id`. Without active hooks, `submit` refuses and starts nothing. Subagents of the main session are refused. `submit` also refuses with infrastructure `plugin_changed`, starting no job, when the plugin code on disk differs from the code the session started with or the code the running MCP server loaded (see [Isolation](#isolation-what-is-and-is-not-protected)).

### Stop policy

The Stop hook (`stop_policy`) reminds Claude before it finishes when a verification is still running, a learning phase is open, the workspace changed with no current verdict covering it, or a verified result has not been learned.

- `nudge` (default): remind once per condition. The reminder is Stop hook feedback (`additionalContext`), not a hook error.
- `gate`: block finishing (`decision: block`) up to `interactive.stopGateMax` (3) times per condition and prompt; the "not learned" reminder blocks once. When the gate is used up for unverified changes, the stop is allowed and counted as unverified.
- `off`: never remind.

While background tasks run, each condition gets at most one hint, which never blocks and does not count against the gate; the usual reminder follows when the background work has ended. Under `nudge`, and for background hints, a Stop that a reminder caused (`stop_hook_active`) is never reminded again.

A verdict is *current* only while the git status digest of the workspace equals the one recorded at inspection. Untracked files below `node_modules`, `.venv` and `__pycache__` are derived caches, not candidate content: they are left out of this digest and of the checkpoint (tracked files there still count), so a Verifier's `import` or test run that rewrites a cache does not void its verdict, and the Verifier runs with `PYTHONDONTWRITEBYTECODE=1`. A stale `PASS` does not count, and `learn` refuses a stale verdict. A rollback-mode `PASS` during which pre-existing files changed, whether by the Verifier's own commands (an install rewriting a lockfile, a test run writing snapshots) or by another process, is recorded as not current from the start: its result carries no learn hint, `learn` refuses it, and status shows `not current: the candidate changed during the inspection`. When the result is delivered, cc-rsi checks the restored files again: the NOTE says they match the candidate only when they do, and otherwise names the files that differ again. When the same files void a `PASS` of the same unchanged candidate twice in a row, the NOTE names the remedy (commit the regenerated file such as an updated lockfile, add a cache to `.gitignore` or delete it, stop a background command that writes them) instead of asking for another `submit`. A rollback-mode Verifier is told to leave existing files byte-identical and to experiment on copies in its scratch directory.

### Skills

| Skill | What it does |
|---|---|
| `/cc-rsi:status` | Memory size and integrity, frozen/sealed flags, the current task's verification state, lineages. Never shows scores. Claude may also invoke it. |
| `/cc-rsi:explore …` | Exploration lineages (next section). User-invoked only. |
| `/cc-rsi:memory …` | `show [path]`, `inventory`, `history`, `log`, `verify`. User-invoked only. |
| `/cc-rsi:freeze` | Freeze memory for Phase 3. User-invoked only. |
| `/cc-rsi:doctor [--live]` | Diagnostics. User-invoked only. |

There is deliberately no skill for unfreezing, restoring, abandoning or sealed evaluation: those run only in a terminal. Each skill runs the CLI with `--report-exit`, so its exit status arrives as a last line `[cc-rsi exit N]` and Claude explains blockers, FAIL checks and refusals (Claude Code aborts a skill whose injected command exits non-zero).

## Exploration lineages

A lineage is a detached Node engine. It runs one `claude -p` process per role message, resuming the same session for each role context, and records every side effect in a memoized op journal. Records live in `~/.cc-rsi/projects/<key>/lineages/<id>/`; role working directories live in `~/.cc-rsi/work/<key>/<id>/`. Actor, Verifier and Curriculum children each get their own `TMPDIR`; the Actor also has a private scratch directory (`actor-private/<episode>/scratch`) that its file tools and shell commands can both use.

| Phase | RSIAgent | What happens | Terminations |
|---|---|---|---|
| `broad` | Phase 1 | A Curriculum authors a wave of independent practice projects and their input fixture trees. The harness captures them and replays each into a fresh project root. Branches run in parallel (`waveConcurrency`, default 2) from the same memory snapshot, each with a fresh Actor and a fresh Verifier. After the wave barrier, each Actor distills in its own context, serially in authored order, on the latest memory. A branch that fails on infrastructure restarts unscored from its immutable fixtures. | `saturated`, `stalled`, `budget_exhausted` |
| `deep` | Phase 2 | A fresh Actor attempts the unchanged target. `PASS` or `FAIL` ends the attempt and the same Actor learns from it, writing a diagnosis for the Curriculum. `UNVERIFIED` asks for evidence leads. A stall gets one forced inspection, then one fresh-context resume with a synthesized work log (optionally on an escalation model, with a one-time Verifier swap). The Curriculum then chooses practice projects (`DECISION: PROJECT`), `READY_FOR_TARGET` or `STALLED`. Any practice forces a fresh target attempt; `STALLED` buys exactly one final target test. | `verifier_pass`, `verifier_pass_curriculum_ready`, `verifier_pass_curriculum_stalled`, `curriculum_stalled_final_target_test`, `target_harness_unverified`, `budget_exhausted` |
| `frozen` | Phase 3 | One target attempt on frozen memory. `FAIL` sends the report back to the same Actor for repair (up to `frozenRepairRounds`, default 8). No learning, no Curriculum. | `frozen_attempt_complete`, `target_harness_unverified` |

A practice candidate (in both phases) is inspected as a fresh replay of its immutable capture at the Actor's own project root, so `<PROJECT_ROOT>` names the same path for the Actor and the Verifier; the Actor's tree waits aside in the lineage's private records and is put back afterwards. A target candidate is inspected live under a full checkpoint.

Any phase can also end `quarantined` (the leakage tripwire fired) or `abandoned`. Infrastructure failures are never terminal: the lineage pauses as `paused_infra` and `resume` continues it. This includes `plugin_changed`: before each role child starts, the engine compares the plugin code with the lineage's baseline and pauses when it changed.

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
- `--model M` sets the Actor, Verifier and Curriculum models. `--actor-model`, `--verifier-model`, `--curriculum-model`, `--escalation-model` and `--summarizer-model` set one role each. Unset roles follow `models.*` in the configuration (including the saved `verifier_model` plugin option), then the session model (when started from a session), `ANTHROPIC_MODEL`, `model` in `~/.claude/settings.json`, and finally Claude Code's default. The resolved models are recorded in `lineage.json`.
- **Without an OS sandbox, `start` is refused** unless you pass `--allow-unconfined` (or set `isolation.allowUnconfined: true` in `~/.cc-rsi/config.json`). With `isolation.sandbox` set to `require` (in any configuration layer, including the saved `sandbox` plugin option) it is refused even with `--allow-unconfined`. See [Isolation](#isolation-what-is-and-is-not-protected). Prefer a disposable container or VM.
- At launch one tiny model call checks that role children can authenticate (`--skip-auth-probe` skips it).
- `--foreground` runs the engine in the current process instead of detaching it.
- Claude itself cannot start or resume lineages from its Bash tool, also when options come before the subcommand (unless the global `exploration.modelMayStart` is `true`).

### Following and controlling a lineage

```sh
cc-rsi explore list                     # ids, phases, statuses
cc-rsi explore status [<id>] [--json]   # counters, cost, isolation, pause reason; never report text or scores
cc-rsi explore log <id> [--follow] [-n N]
cc-rsi explore show <id>                # role contexts with `claude --resume <sid> --fork-session` hints
cc-rsi explore stop <id> [--timeout S]  # SIGTERM; the engine stops its children and pauses (paused_user)
cc-rsi explore resume <id> [--accept-drift] [--foreground]
cc-rsi explore abandon <id> [--reason TEXT]   # human-only; records termination "abandoned"
```

`stop` escalates to the engine's process group after `--timeout` seconds (default 60). It signals only an engine on this machine: a lease written under an older hostname of the same machine is accepted when the machine id matches or the local process's command line is this lineage's engine.

`resume` first runs a write-free admission check. It refuses a terminal lineage, a live engine, tampered memory, a frozen or sealed store for a learning lineage, or changed plugin code (pass `--accept-drift` to accept the change; the lineage's prompt snapshot is then refreshed and the accepted drift recorded in `lineage.json`). Depending on where the lineage paused, it grants one more continuation (liveness pause), one more evidence round (practice `UNVERIFIED` exhaustion) or four more commit attempts (commit ceiling); every other pause re-runs the interrupted step in the same role sessions.

`result.json` uses RSIAgent's snake_case keys (`termination`, `target_verifier_verdict`, `curriculum_decision`, `candidate_digest`, tree hashes, `official_evaluator_calls: 0`, …) so it can be compared with RSIAgent records. For a `deep` lineage the final candidate is the tree the Verifier judged, captured before the same Actor learns; `candidate_changed_after_verdict` records whether the Actor changed its live project root while learning (`false` for `frozen`, `null` for `broad`). `curriculum_decision` is the decision that ended the last evolution, or `null` when a budget cut it off.

## Phase 3: freeze, frozen lineages, sealed evaluation

1. **Freeze memory**: `/cc-rsi:freeze` or `cc-rsi memory freeze`. Interactive `learn` and new `broad`/`deep` lineages are then refused. Unfreezing is human-only: `cc-rsi memory unfreeze` in a terminal.
2. **Run a frozen lineage**: `cc-rsi explore start --phase frozen --target-file task.md [--fixtures DIR] --yes`. The engine checks that the frozen tree is unchanged before and after the attempt.
3. **Configure the evaluator** in `~/.cc-rsi/config.json` (global only, never from a project file):

   ```json
   {"evaluation": {"command": ["python3", "/abs/path/grade.py"], "timeoutSec": 900, "retries": 2}}
   ```

   The command runs with its working directory set to a fresh copy of the lineage's final candidate, an allowlisted environment, `RSI_CANDIDATE_ROOT`, `RSI_TASK_FILE` (a file holding the target text) and a `TMPDIR` inside the private run directory (removed afterwards; `HOME` is unchanged). It must print the score as the last line of stdout: a JSON number or `{"score": n}`. A non-zero exit or a timeout is retried; the same error 3 times in a row (`identicalErrorLimit`) records `blocked`. The evaluator is never started on a candidate that holds a symbolic link leaving the tree (an absolute target, a target climbing out, or one resolving outside) or whose capture had to copy the tree verbatim: the run is recorded as `blocked` with a `blocked_reason` and no attempts.
4. **Evaluate, in a terminal**: `cc-rsi eval run <lineage> [--retries N] [--json-out PATH]`. The lineage must be a finished `deep` or `frozen` lineage whose final candidate is unchanged. The score is printed only when stdout is a terminal; otherwise it is recorded and `cc-rsi eval show <lineage> [--run R]` shows it later, again only on a terminal.

Sealed evaluation freezes memory if it is not frozen, checks the frozen tree before and after, and marks the store sealed. After that, learning stays closed until a human runs `cc-rsi memory unfreeze --after-sealed`; later lineage results then carry `learning_after_sealed_evaluation: true`.

The score is kept away from every model context: `eval` refuses to run inside Claude Code (`CLAUDECODE` is set), Claude's Bash is denied `cc-rsi … eval`, and Claude's file tools are denied everything under `~/.cc-rsi`, apart from the memory view, the shim and an open learning draft. `--json-out` refuses paths inside the project, any git worktree of the project, the role work trees, the interactive Verifier scratch, the lineage's candidate root and copy, and the sealed run directories, compared both as written and after resolving symbolic links.

## Configuration

### Plugin options (`userConfig`)

Set them in Claude Code's plugin configuration (`/plugin`) or at install time with `--config key=value`.

| Option | Default | Values |
|---|---|---|
| `verifier_model` | `""` (the session's model) | An alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model id |
| `stop_policy` | `nudge` | `off`, `nudge`, `gate` |
| `sandbox` | `auto` | `auto`: use the Claude Code sandbox when it works, otherwise degrade explicitly. `require`: refuse to run Verifier and lineage children without it. `off`: never use it |

They map to `models.verifier`, `interactive.stopPolicy` and `isolation.sandbox` and form the plugin-options layer of the precedence below. Only options you saved count; until you save one, the lower layers (including `~/.cc-rsi/config.json`) apply. Each part of cc-rsi reads them where Claude Code provides them:

- **Hooks** receive `CLAUDE_PLUGIN_OPTION_*` for saved options. SessionStart records them in the session record, and the prompt and attestation hooks record them again when you change an option mid-session, so the next `submit` uses the new value.
- **The MCP server** applies the recorded options. Once a hook has recorded them, the record is complete and the server's own environment (`CC_RSI_OPT_*`) is ignored: that environment is set when the server starts, so it can be stale, and Claude Code also puts the manifest default of an unsaved option into it. A stale value therefore never overrides an option you saved later (an old `sandbox=off` never downgrades a saved `require`), and an option you cleared stays cleared. Only when no hook recorded the options (hooks not running) does the server use its environment, without values equal to the manifest default, so the server, the hooks and the session banner agree.
- **The `cc-rsi` CLI** (terminal or skill) reads the options Claude Code saved in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` under `pluginConfigs`: the entry `cc-rsi@<marketplace>` of the marketplace the running plugin was installed from, or `cc-rsi@inline` when it runs from a directory (`--plugin-dir`); failing that, the only cc-rsi entry. `sandbox: require` saved in any cc-rsi entry applies. `CLAUDE_PLUGIN_OPTION_*` in the environment overrides the saved values. When there are no configuration warnings, `cc-rsi doctor` names the options it applied and their source in its `config` line.

### JSON configuration

| File | Scope |
|---|---|
| `~/.cc-rsi/config.json` | Global (all projects) |
| `<project>/.claude/cc-rsi.json` | One project (restricted, see below) |

Precedence, lowest to highest: built-in defaults, global file, project file, non-empty plugin options, command-line flags. Keys can be nested objects or dotted strings (`{"models.verifier": "opus"}`). Unknown keys and invalid values are dropped with a warning (`cc-rsi doctor` lists them); an invalid value falls back to the next lower layer.

- **G** (global only): ignored, with a warning, when it appears in a project file. This stops a cloned repository from planting an evaluator command, extra environment variables, weaker isolation or a disabled leakage tripwire.
- **T** (tighten only): a project file may only make the value stricter (`isolation.sandbox`: `off` < `auto` < `require`; network lists may only lose entries; `webTools` may only be turned off). A stricter project value wins even over plugin options and flags.

| Key | Default | Notes |
|---|---|---|
| `mode` | `"learn"` | `"frozen"`: Phase-3 reuse (also implied by a frozen store) |
| `models.actor` / `verifier` / `curriculum` / `summarizer` | `""` | `""` or `"inherit"`: session model, then `ANTHROPIC_MODEL`, then `model` in `~/.claude/settings.json`, then Claude Code's default. The summarizer falls back to the Actor model |
| `models.escalation` | `""` | Model for a stalled target Actor's fresh-context resume. `""` disables escalation |
| `effort.actor` / `verifier` / `curriculum` / `summarizer` | `""` | Passed as `--effort` when set |
| `interactive.enabled` | `true` | `false`: every tool refuses with a pointer |
| `interactive.taskMessages` | `3` | Recent user messages the Verifier receives (1–16) |
| `interactive.waitSeconds` | `100` | Per-call wait (10–110); a call still stops waiting early enough to answer about 10 s before `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (default 120 s) would background it |
| `interactive.allowUnverified` | `true` | Allow the `UNVERIFIED` verdict |
| `interactive.verifierIdleHours` | `24` | After this idle time a fresh Verifier context starts, seeded with prior reports |
| `interactive.stopPolicy` | `"nudge"` | `off` / `nudge` / `gate` |
| `interactive.stopGateMax` | `3` | Blocks per condition and prompt under `gate` (0–8) |
| `interactive.baseline` | `true` | Snapshot the workspace file state when a task opens |
| `interactive.rewake` | `true` | Async hook that wakes the session when a verdict lands |
| `interactive.checkpointMaxBytes` / `checkpointMaxFiles` | `268435456` / `20000` | Above either limit the checkpoint is detect-only (no restore). A project value below the global (or default) value is honoured with a warning |
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
| `exploration.unverifiedRounds` | `3` | Target: `UNVERIFIED` rounds in a row, with no tool action in the evidence work between them, before the attempt stalls. Practice: `UNVERIFIED` inspections before the lineage pauses (`unverified_exhausted`) |
| `exploration.unverifiedCeiling` | `8` | Emergency ceiling: `UNVERIFIED` rounds in one target Actor context before the attempt stalls |
| `exploration.targetResumes` / `branchRetries` / `frozenRepairRounds` | `1` / `1` / `8` | |
| `exploration.stopPolicy` | `"curriculum_review"` | Or `"verifier_pass"`: stop at the first target `PASS` |
| `exploration.curriculumMemoryAccess` | `"read_only"` | Or `"none"` |
| `exploration.escalationHandoverReports` | `false` | Give the swapped Verifier the prior reports (RSIAgent: no) |
| `exploration.synthesizeWorklog` | `true` | Summarizer work log and strategy review for resumes |
| `exploration.webTools` **T** | `false` | WebFetch/WebSearch for lineage Actors |
| `exploration.maxCostUsd` | `0` | `0` = off; checked at boundaries, ends `budget_exhausted` |
| `exploration.modelMayStart` **G** | `false` | Let Claude's Bash run `cc-rsi explore start` or `resume` |
| `memory.dir` **G** | `""` | Override the store root: an absolute path, or `~/…` for your home. Any other relative value is ignored with a warning (the default store is used). A store outside `~/.cc-rsi` is private like `~/.cc-rsi` (unless it contains the project). A store inside a project stays private by path, but searching that project is not refused for covering it; the session start line warns, so move it outside |
| `memory.maxFiles` / `maxTotalBytes` / `maxFileBytes` | `400` / `4194304` / `65536` | Commit limits; an over-limit draft goes back to the same Actor to condense |
| `memory.keepHistory` | `true` | Snapshot memory after every commit |
| `memory.promptInventory` | `40` | Inventory lines shown in the session context |
| `audit.sealedTextFiles` **G** | `[]` | Held-out task texts or grader sources for the 8-word shingle tripwire |
| `audit.shingleWords` **G** | `8` | Shingle length (3–16) |
| `evaluation.command` **G** | `[]` | Sealed evaluator argv |
| `evaluation.timeoutSec` / `retries` / `identicalErrorLimit` **G** | `900` / `2` / `3` | |
| `children.claudeBin` **G** | `""` | `claude` binary for role children (default: the running Claude Code, else `claude` on `PATH`) |
| `children.envPassthrough` **G** | `[]` | Extra environment variable names (or `PREFIX_*`) passed to role children |
| `children.keepStreams` | `true` | Keep `stream.jsonl` for every role invocation |

`CC_RSI_HOME` moves the whole `~/.cc-rsi` directory.

## Isolation: what is and is not protected

Every role child (Verifier, lineage Actor, Curriculum, summarizer) runs as `claude -p` with `--restricted --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk`, an explicit tool list, an allowlisted environment (a role with tools gets its own `TMPDIR`), no MCP servers, and a per-invocation settings file with path rules and a fail-closed role guard hook. On top of that, the isolation mode is recorded in every verdict and lineage record:

| Mode | Used by | Meaning |
|---|---|---|
| `sandbox` | Verifier and lineage children, when an OS sandbox works | Claude Code's sandbox wraps the role's Bash: writes are confined (a Verifier writes only to its scratch directory), hidden paths are unreadable, network is limited to the configured domains (none by default). The interactive workspace is still checkpointed and restored, and a change made to it during the inspection from outside ends the job as infrastructure. |
| `rollback` | Interactive Verifier without a sandbox | The Verifier runs Read, Grep, Glob and Bash **unattended** under the guards below, and the workspace is restored from a checkpoint after every inspection. |
| `unconfined` | Lineages without a sandbox, only with `--allow-unconfined` | Actor, Verifier and Curriculum children run Bash **unattended** with only the guards below. A target project root is restored after each Verifier inspection; a practice Verifier inspects a fresh replay at the Actor's project root, which is discarded afterwards. Nothing a role does outside those roots is rolled back. |

> [!WARNING]
> **Without an OS sandbox, the Verifier and every lineage child run Bash commands unattended, with your user account's permissions, protected only by rollback and heuristics.** Claude Code's sandbox needs `bubblewrap` and `socat` on Linux (or `sandbox-exec` on macOS); it is unavailable on WSL1 and in many containers. In that case:
>
> - The interactive Verifier degrades to `rollback` (announced at session start). In a git repository, rollback restores git-tracked and untracked-not-ignored files under the workspace root, except untracked files below `node_modules`, `.venv` and `__pycache__`; outside git, every file except `.git`, `node_modules`, `.venv` and `__pycache__` (a checkpoint of your home directory or `/` is refused). It does **not** undo processes, services, databases, network calls, `.git` internals, ignored files, or anything outside the workspace. Above 256 MiB or 20 000 files it only detects changes. The Verifier is told what its checkpoint restores, and an infrastructure result lists the paths that were not rolled back.
> - Lineages refuse to start unless you pass `--allow-unconfined`. Run unconfined lineages in a disposable container or VM.
> - The path guards and the Bash scanner are heuristics against accidents and casual access, not a security boundary. Every role runs as your OS user and can read whatever you can read through obfuscated shell commands.
>
> Set `sandbox` to `require` to refuse instead of degrading.

What the guards cover (heuristically, see the warning):

- **cc-rsi state.** Claude's file tools are denied everything under `~/.cc-rsi` and an external `memory.dir` store, except reading the memory view and the shim and using the open learning draft. Its shell commands may not name those paths, whether directly, through `~`, `$HOME` or a relative path, through a glob or brace expansion that can reach them, or through a recursive walk rooted above them (`grep -r`, `rg`, `find`, `du`, `tree`, `ls -R`, `cp -r`, `rsync -a`, `tar`, …), also inside `sh -c` and `eval` strings. A walk that cannot reach them is not refused: `rg`, `fd`, `ag`, `tree` and `ls -R` skip dot directories such as `~/.cc-rsi` unless told to show hidden files, and `find -maxdepth`, `tree -L`, `rg --max-depth` and `fd -d` stop above them. A command too large to check in time is refused; split it or write the file with the Write tool. The shim may be run, never written.
- **The plugin code.** The running plugin (its root, and `CLAUDE_PLUGIN_ROOT`) is read-only: Claude's Edit and Write tools are denied there (Read and Grep stay allowed), and a shell command may name it only as the program it runs, as in `node <plugin root>/bin/cc-rsi …`. Role children get it read-only too (file tools, and the sandbox's write rules). SessionStart fingerprints the plugin's `lib`, `hooks`, `bin`, `mcp` and `prompts`, and so does the MCP server when it starts (for the code it loaded); `submit` and the verification job refuse with infrastructure `plugin_changed` when the code changed since then, and a lineage pauses (`plugin_changed`) before its next role child. `/clear` does not accept a change: the MCP server keeps running and still compares with the code it loaded, so only a restart of Claude Code does. These rules are off when the session's project is, or lies inside, the cc-rsi checkout the plugin runs from (developing cc-rsi with cc-rsi); a plugin installed under the Claude config directory is always protected.
- **Verifier transcripts.** Once the session has started a Verifier, the Claude Code transcript directory of every candidate root it inspected (`~/.claude/projects/<slug>/`, and the same under `CLAUDE_CONFIG_DIR`) is denied to Claude's file tools and shell commands, except Claude Code's auto-memory (`<slug>/memory`, also through a glob such as `~/.claude/projects/*/memory/MEMORY.md`) and the session's own transcript files; searches across `~/.claude/projects` are denied too, and so are tree walks and interpreters given a directory above them. Commands that only name the config directory (`ls ~/.claude`, `cd ~/.claude`, copying a file into it, a commit message) are not refused. Before every `--resume` the job compares the transcript with the fingerprint its last job recorded; a changed transcript retires the context and a fresh one starts with the earlier reports.
- **The Actor's reasoning.** Every role child is denied, under `~/.claude` and `$CLAUDE_CONFIG_DIR`, `projects`, `.credentials.json`, `plans`, `todos`, `tasks`, `file-history` and `history.jsonl`; the session temp directories `<TMPDIR>/claude-<uid>` and `/tmp/claude-<uid>`; cc-rsi's own state (`projects`, `run`, `bin`, `config.json`, `logs`, other lineages' work trees, the interactive Verifiers' scratch); and an external memory store. `shell-snapshots` and `session-env` stay readable because a role's own Bash sources them, and so do a role's own temp directory (`TMPDIR` = `.tmp` inside its scratch) and its own Claude Code session directory (where large tool results are saved): a hidden directory that contains it is denied entry by entry around it (plus every transcript `*.jsonl` below it) in the permission rules and the sandbox, so Read and Bash can reach the role's own tool results.

Further limits that hold in every mode:

- The sandbox, when present, wraps Bash only; hooks, Claude Code itself and file tools are governed by permission rules and the role guard.
- Canonical memory, Verifier reports, Verifier transcripts and the plugin code are **tamper-detected**, not tamper-proof: the memory tree hash is compared with the last commit before every sensitive step, reports are re-hashed on read, transcripts are fingerprinted before `--resume`, and the plugin code is fingerprinted at session start and when the MCP server starts.
- Without an OS sandbox, a role's Bash (a lineage child, or the interactive Verifier in rollback mode) can still write the plugin code. The change is detected before the next lineage role child starts (the lineage pauses), and for interactive verification at the next `submit` and job start.
- Role transcripts live in `~/.claude/projects/` like any session. Interactive Verifier sessions share your project's transcript folder and can appear in session pickers; Claude is kept out of them by the guard only.

## Command-line reference

```
cc-rsi status [--json] [--session <sid>] [--project <dir>]
cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>*]
cc-rsi memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external*] | restore <N>*
              | freeze | unfreeze [--after-sealed]* | export <dir> | import <dir>* | drafts [--prune*]
cc-rsi explore preflight|start <start options> | status [<id>] [--json] | log <id> [--follow] [-n N]
              | stop <id> [--timeout S] | resume <id> [--accept-drift] [--foreground]
              | abandon <id> [--reason TEXT]* | show <id> | list
cc-rsi eval run <lineage> [--retries N] [--json-out PATH]* | eval show <lineage> [--run R]*
cc-rsi verify cancel [--session <sid>] [--grace SECONDS]*
cc-rsi gc [--older-than DAYS] [--dry-run] [--streams] [--project <dir> [--session <sid>]]
cc-rsi version | help
```

`*` marks human-only commands: inside Claude Code they refuse with exit 65 and print `in a terminal, run: <command>`, and Claude's Bash is denied running them (the guard parses the command, so a commit message, an issue title or a path that merely mentions them is not refused; a command that also clears `CLAUDECODE`, as with `env -u CLAUDECODE`, `env -i`, `unset CLAUDECODE` or `CLAUDECODE=`, is refused whenever its text names `cc-rsi` followed by a human-only subcommand, because the parsed words can miss a computed command word). Most commands accept `--project <dir>` (default: the current directory's project). Exit codes: 0 ok, 1 error, 2 usage, 3 refused by a blocker, 64 inside a role child, 65 human-only. `--report-exit`, given after the command word, makes the CLI print `[cc-rsi exit N]` as its last stdout line and exit 0 (the skills use it); inside a role child the CLI still exits 64. `cc-rsi help` prints the full usage, including the configuration precedence.

- `memory verify` checks canonical memory against its last commit. If it changed outside a commit, `--accept-external` records the change as a commit and `restore <N>` rolls back to history snapshot `N` (see `memory history`). While memory is frozen, an external change cannot be accepted; `memory verify` then names the `restore <N>` that reinstates the frozen tree from its history snapshot.
- `memory export <dir>` / `import <dir>` copy memory out of and into the store (import is a recorded commit).
- `memory drafts --prune` removes only drafts nobody can continue: drafts whose owner is gone or whose episode is committed, and session drafts whose learning phase is no longer open. Drafts of a running or paused lineage are always kept.
- `verify cancel` stops a running interactive verification. The job restores the workspace and records infrastructure `cancelled`, not a verdict. The pid is signalled only when it is identified as the job on this machine (by its recorded process start token, else by its command line, else by a heartbeat younger than 90 s); otherwise the command refuses (exit 3) and explains how to stop it by hand. After `--grace` seconds (default 60) the job's process group is stopped, if the job leads its own group.
- `doctor --release-lock <root>` removes the workspace lock of `<root>` and every restore-failed marker of it. It refuses while the lock is live and has not failed to restore (renewed within 30 s, or its holder is a live process on this machine).

## The ~/.cc-rsi directory and gc

cc-rsi keeps its state outside every workspace and outside Claude Code's plugin data, so memory survives plugin uninstalls.

```
~/.cc-rsi/
  config.json                    global configuration
  probe.json                     cached sandbox probe
  bin/cc-rsi                     terminal shim
  logs/                          hooks.log, mcp.log, cli.log, jobs.log
  run/                           attestations, workspace locks and restore-failed markers, content-addressed
                                 child settings, prompts and policies, the session index
                                 (without /etc/machine-id, the machine id is kept in
                                 /var/tmp/cc-rsi-<uid>/machine-id, never in this shared home)
  vscratch/<verifierSessionId>/  interactive Verifier scratch (its TMPDIR is .tmp/ inside)
  work/<key>/<lineage>/          lineage role working directories (role-visible), with the Actor's
                                 private scratch under actor-private/<episode>/scratch
  projects/<key>/                one directory per project (<key> = <name>-<12 hex of the root path>)
    store/                       canonical memory, journal, history, reports, frozen/sealed markers
    sessions/<sid>/              task state, captured requests, the scheduled-prompt ledger, verification
                                 jobs and logs, verdicts, checkpoints, displaced copies
    views/<sid>/memory/          the read-only memory view given to the main session
    drafts/<episode>/            interactive learning drafts
    lineages/<id>/               lineage.json, state.json, ops.jsonl, events.jsonl, result.json, engine.log, priv/
    sealed/<lineage>/<run>/      sealed evaluation runs (evaluation.json)
```

A project is the git common directory's parent, so all worktrees of a repository share one memory. `memory.dir` (global) moves the store.

`cc-rsi gc [--older-than DAYS] [--dry-run] [--streams] [--project <dir> [--session <sid>]]` removes derived and transient data only: attestations older than an hour; views, checkpoints, displaced copies and Verifier invocation logs of sessions that ended more than `DAYS` (default 14) ago, or that never recorded a SessionEnd (killed, crashed) and show no activity for `DAYS`; old Verifier scratch of closed or retired tasks; work trees of finished lineages; and, with `--streams`, the invocation streams of finished lineages. Records (task state, verdicts, journals, results, reports, evaluations) are never deleted, and anything a running job, a live engine or a workspace lock may need is kept. `--project` limits gc to one project and `--session` to one session; the global sweeps (attestations, Verifier scratch) then do not run. A path that cannot be removed is reported (with a `chflags` or `lsattr` hint for permission errors) and skipped; gc continues and exits 1 at the end.

## Troubleshooting

Start with `/cc-rsi:doctor` (or `cc-rsi doctor` in a terminal). Each check prints `PASS`, `WARN` or `FAIL` with a remedy that names the real paths (`<home>/config.json`, `<project>/.claude/cc-rsi.json`): Node, the `claude` version and required flags, git, `~/.cc-rsi`, the terminal shim and `PATH`, memory integrity, pending commits and abandoned drafts, workspace locks (including dead jobs whose recovery is pending, which doctor also starts), lineages whose engine died or paused, the sandbox, whether hooks are active in the session, the MCP server's tool list, the models and configuration warnings.

`cc-rsi doctor --live` adds tiny real model calls (two, or three with a sandbox): an authentication probe with the exact role-child flags and environment, a hook probe on the first message and on `--resume`, and a live sandbox probe when the static one passes. The sandbox probe reports enforcement only when its test command demonstrably ran; otherwise it reports `WARN` (inconclusive).

| Symptom | Cause and fix |
|---|---|
| `cc-rsi: command not found` in a terminal | No session has written the shim yet, or its directory is not on `PATH`. `/cc-rsi:doctor` (check `shim`) prints the `export PATH=…` line. Meanwhile run `node "<plugin root>/bin/cc-rsi" …`, the command a refused human-only command prints. |
| `submit` says it "cannot attest this call" | The plugin's hooks are not running in this session (`disableAllHooks`, `allowManagedHooksOnly`, or the plugin is disabled). Run `/cc-rsi:doctor` in that session; it checks whether the hooks captured your requests. |
| Verification ends `INFRASTRUCTURE: … (auth)` | Role children run with `--restricted`, which ignores your settings files. cc-rsi forwards `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`, `forceLoginOrgUUID` and provider `env` entries from `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), and passes `ANTHROPIC_*`, `AWS_*`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `CLAUDE_CODE_OAUTH_TOKEN`, proxy and CA variables from the environment. Add other variables with `children.envPassthrough`. Confirm with `cc-rsi doctor --live`. |
| `INFRASTRUCTURE: … (config)` | The model name was rejected; check `verifier_model` / `models.*`. |
| `INFRASTRUCTURE: … (plugin_changed)` | The plugin code changed after the session started (an update or an edit). Restart Claude Code: a new session, or `--resume`/`--continue` of this one (`/clear` is not enough: the MCP server keeps the code it loaded). A restarted session accepts the code it loads and says so in its start line. Editor swap files and `.DS_Store` are not code. |
| `INFRASTRUCTURE: … (candidate_changed_during_inspection)`, or a `PASS` whose NOTE says it does not count as current | Something outside the inspection, usually a background process started before `submit`, changed the workspace while the Verifier inspected it; in rollback mode it can also be the Verifier's own commands. Stop such a process, then let Claude submit again. If the NOTE says the same files changed during the previous inspection of the same candidate, make them stable first (commit the regenerated file, ignore or delete the cache, stop the writer). |
| Claude's edits are blocked: "an independent verification of this workspace is running" | Expected while a job runs. Claude should call `wait_verdict`; you can cancel with `cc-rsi verify cancel`. If the message says a job "ended without restoring its checkpoint", its recovery is running: retry shortly (`cc-rsi doctor` shows it as recovery pending). |
| "a verification failed to restore the workspace" | The workspace lock is kept on purpose. Inspect the displaced copies under `~/.cc-rsi/projects/<key>/sessions/<sid>/displaced/<job>/`, then run `cc-rsi doctor --release-lock <root>` in a terminal (it also removes the restore-failed markers). |
| `verify cancel` says the job "is not cancelled" | cc-rsi could not prove that the pid is the job (no start-token match, unreadable command line, heartbeat older than 90 s), so it signals nothing. Check the pid and stop it with `kill` yourself, or let the next session start, `submit` or `status` recover the job. |
| Claude Code asks permission to read the memory view | The guard pre-approves reads of the view and the open draft, but this is unverified on real Claude Code. Add `Read(~/.cc-rsi/projects/*/views/**)` (and, for learning, `Edit(~/.cc-rsi/projects/*/drafts/**)`) to your permission allow rules. |
| A learning phase is open but Claude lost the confirmation code (for example after a compaction) | `learn` re-shows the current stage message and its code; `memory_commit` with `abandon: true` discards the draft without one. After a compaction or resume, SessionStart reminds Claude of the open phase. |
| `memory changed outside a commit` | `cc-rsi memory verify` shows the difference. Keep it with `cc-rsi memory verify --accept-external` or roll back with `cc-rsi memory restore <N>`. While memory is frozen only the restore works; `memory verify` names the snapshot. |
| A lineage is `paused_infra` | `cc-rsi explore status <id>` shows the class and detail. Fix the cause, then `cc-rsi explore resume <id>`. `context_lost` means an Actor or Curriculum transcript is gone (for example pruned by Claude Code's `cleanupPeriodDays`); that context cannot be continued, so abandon the lineage. `plugin_changed` means the plugin code changed while the lineage ran; check the change, then resume with `--accept-drift`. `candidate_capture_mismatch` means the copy of the tree a target Verifier judged did not match that tree, so it was not scored; a target attempt that an earlier cc-rsi version started on a project root holding special files (FIFOs, sockets) pauses there again on every resume, so abandon such a lineage. |
| `resume refused: the plugin changed since the lineage started` | The plugin was updated after the lineage began (or the version directory it ran from was cleaned up). Resume with `--accept-drift` to continue on the current code (recorded in `lineage.json`; the prompt snapshot is refreshed, and messages sent before the update replay their recorded replies even when the new templates word them differently). |
| `explore stop` refuses: the engine "runs on host …" | The engine lease names another host and cc-rsi cannot show that the pid is this lineage's engine. Check it with `ps -p <pid> -o command=` on the machine that runs it and stop it there (or with `kill <pid>` if it is local). |

Logs: `~/.cc-rsi/logs/`, `jobs/<job>.log` in the session directory, `engine.log` in the lineage directory, and one directory per role invocation (`prompt.md`, `stream.jsonl`, `stderr.txt`, `guard.jsonl`, `meta.json`) under the `ctx/` folders.

## Versions and updates

`.claude-plugin/plugin.json` carries a `version` (currently `0.1.0`). Claude Code installs and updates by that version, not by commit, so **every release must bump it**; commits pushed without a bump do not reach installed users. `cc-rsi version` prints the version and the plugin root in use, and the MCP server reports the same version. (The specification originally omitted `version` so installs would track commits, but `claude plugin validate --strict` requires it.)

## Development

```sh
npm test                                   # node scripts/run-tests.mjs: every test/**/*.test.mjs except test/e2e
node scripts/run-tests.mjs test/engine     # one directory or file
node scripts/run-tests.mjs test/hooks --test-name-pattern guard   # node options keep their values
npm run smoke                              # CC_RSI_E2E=1: real claude, --model haiku, spends tokens
CC_RSI_E2E_FULL=1 npm run smoke            # also the SIGTERM-then-resume lineage scenario
claude plugin validate . --strict          # manifest, hooks, MCP and skills
claude --plugin-dir .                      # try the working tree in a session
```

- Zero runtime dependencies; tests use `node:test` only and never touch `~/.cc-rsi`, your Claude Code configuration (every temporary home gets its own `CLAUDE_CONFIG_DIR`) or the network. Role children are exercised against a fake `claude` (`test/fake-claude/`) that emulates stream-json, session semantics, crashes and real hook execution.
- The suite also runs with a `TMPDIR` containing spaces or non-ASCII characters, cleans its temporary directories when interrupted (SIGINT/SIGTERM), and, when run as root, skips the few tests that need an unprivileged user if uid 65534 cannot reach `TMPDIR`.
- The engine's crash matrix (`test/engine/crash-matrix.test.mjs`) kills or throws at every journaled op of a reference broad run, a broad run whose branch restarts unscored, and a reference deep run, and checks that resume reproduces the uninterrupted result. `CC_RSI_CRASH_LANES=N` bounds its parallelism; `CC_RSI_CRASH_MATRIX=full` also faults at every op start and adds a deep run with a practice project.
- Prompt goldens: after a deliberate prompt change, `CC_RSI_UPDATE_GOLDENS=1 node scripts/run-tests.mjs test/prompts/render.test.mjs`, then review the diff.
- `test/plugin/boundaries.test.mjs` enforces the module import boundaries; only `lib/runtime/child.mjs` may spawn `claude`.

Current state: `npm test` runs 775 tests, all passing; `claude plugin validate . --strict` passes with no warnings. The real-model smoke with the extra scenario (`CC_RSI_E2E_FULL=1 npm run smoke`, Claude Code 2.1.296, haiku) passed all six scenarios: setup, `doctor --live`, an interactive `submit` through the plugin, a broad lineage, a broad lineage stopped mid-wave and resumed, and freeze plus a frozen lineage plus sealed evaluation. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#verify-early-outcomes).

## Known limitations

These remain after the latest review; each is detected or bounded rather than prevented.

1. **Background processes are not stopped.** The workspace lock pauses Claude's new edits and commands, not processes started before `submit`. Their changes are detected after the inspection (sandbox: no verdict; rollback: a `PASS` that is not current), and files they only create are not counted. In rollback mode a change made by the Verifier's own commands looks the same and also makes the `PASS` not current (untracked derived caches below `node_modules`, `.venv` and `__pycache__` excepted).
2. **Unsandboxed roles can write the plugin code through Bash.** Without an OS sandbox only their file tools are denied; the change is detected before the next lineage role child and at the next `submit`, not prevented.
3. **Guards are heuristics.** All roles and your session share one OS user; the Bash scanner stops accidents and casual access, not obfuscated commands. Three findings of the latest review are still open. An `rg` walk counted as skipping dot directories still enters them under a ripgrep configuration with `--hidden` (`RIPGREP_CONFIG_PATH`) or with `-g`/`--iglob` globs, and a depth-limited `find` does not account for the walk its `-exec` or a piped `xargs` starts, so such commands can read `~/.cc-rsi` and Verifier transcripts. The transcript rule does not see interpreter code fed through a here-document (`python3 - <<'EOF'`), a link to the transcript directory made and read in one command, or `git diff --no-index` of it. A line of here-document text that starts with a human-only `cc-rsi` command (Claude Code's commit-message template, a PR body, a changelog) is still parsed as a command, so such a commit is refused.
4. **Detect-only checkpoints restore nothing.** Above `interactive.checkpointMaxBytes` / `checkpointMaxFiles` the Verifier is told that nothing is restored, and the result lists the changed paths.
5. **Prompts without a `source`.** When Claude Code omits the UserPromptSubmit `source` field, a prompt Claude scheduled is recognised only by the exact (trimmed) text of a successful CronCreate, ScheduleWakeup or RemoteTrigger call of this session, while that schedule can still fire. Typing the same text while it can is taken as the scheduled prompt. A schedule that no task list has shown yet counts as able to fire until it is deleted or 8 days have passed.
6. **Unverified on the real binary:** the asynchronous rewake of an idle session and the permission pre-approval of the memory view (`wait_verdict` and a manual allow rule are the fallbacks), sandbox-mode runs and Node 18.
7. **The specification lags.** `docs/design/SPEC.md` has not been updated for the latest fixes; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#recorded-deviations-from-the-specification) lists where the code now differs.

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
