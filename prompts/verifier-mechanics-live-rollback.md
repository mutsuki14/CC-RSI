## main
Your shell commands are NOT sandboxed: network access and other processes are NOT isolated. You must not intentionally change the candidate, and you have no file-editing tools. {{CHECKPOINT}} VERIFIER_SCRATCH names your private writable scratch directory; it persists across your commands and may hold copies, renders, extracted archives, databases, or any other investigative artifacts. Write scratch files only under VERIFIER_SCRATCH, and copy inputs there before using a tool that expects to write beside its input. Commands that would mutate remote systems may be refused by the harness. State in an external service outside this workspace cannot be rolled back: observe such services without sending mutating requests. {{EXPERIMENTS}} These mechanics protect the scored state without prescribing your method.

## checkpoint-full
At the beginning of this inspection the harness checkpointed the candidate's files; when this inspection ends it restores every changed file, so the effects your commands have on those files do not enter the scored state. The checkpoint covers the candidate's files only: running processes, services, databases, version-control internals, and anything outside the candidate root are not rolled back.

## checkpoint-listed
At the beginning of this inspection the harness checkpointed the candidate's files that git tracks or would add, except untracked files under node_modules, .venv and __pycache__ directories (outside a git repository: every file except those under such directories); when this inspection ends it restores every changed one of them, so the effects your commands have on those files do not enter the scored state. The checkpoint covers those files only: files that git ignores (such as build outputs, caches and local environment files), the skipped files, running processes, services, databases, version-control internals, and anything outside the candidate root are neither rolled back nor reported, so leave them as they are.

## checkpoint-detect
The candidate is too large for the harness to checkpoint: it only detects which files change, and NOTHING you change under the candidate root is restored. Do not create, modify, move, or delete anything under the candidate root, build outputs and caches included; copy what you need to build, run, or modify into VERIFIER_SCRATCH and work on the copy there. Running processes, services, databases, and anything outside the candidate root are not rolled back either.

## experiments-rollback
Establish the original candidate's properties before destructive experiments; a property created only by your own test is not candidate evidence.

## experiments-listed
Establish the original candidate's properties before destructive experiments; a property created only by your own test is not candidate evidence. Leave every file the candidate already has byte-identical: run destructive or mutating experiments on a copy in VERIFIER_SCRATCH, and prefer commands that do not rewrite existing files (for example a clean install from the lockfile instead of an install that updates it, test runners in CI mode so they never write snapshots, linters and formatters without their fix or write options). Tools that write caches or compiled files beside the sources (bytecode, build caches, generated stubs) rewrite candidate files as a side effect: Python already runs with PYTHONDONTWRITEBYTECODE=1, and other tools' cache or output directories can usually be pointed into VERIFIER_SCRATCH. If a file the candidate already has differs from the checkpoint when this inspection ends, whoever changed it, a PASS does not count as current verification of this workspace.

## experiments-detect
A property created only by your own test is not candidate evidence.
