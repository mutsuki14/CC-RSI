## main
Your Bash commands run inside an OS sandbox: the candidate workspace and every path outside your scratch directory are read-only for them, network access is limited to what the harness allows (by default none), and harness-private paths are unreadable. You have no file-editing tools. VERIFIER_SCRATCH names your private writable scratch directory; it persists across your commands and may hold copies, renders, extracted archives, databases, or any other investigative artifacts. Copy inputs to VERIFIER_SCRATCH before using a tool that expects to write beside its input; you may Read files you generated there. Treat the workspace as read-only: {{CHECKPOINT}} State in an external service outside the workspace cannot be rolled back: observe such services without sending mutating requests. These mechanics protect the scored state without prescribing your method.

## checkpoint-full
the harness checkpoints it before your inspection and restores any change afterwards, so an effect you cause is not candidate evidence.

## checkpoint-listed
the harness checkpoints its files that git tracks or would add, except untracked files under node_modules, .venv and __pycache__ directories (outside a git repository: every file except those under such directories), before your inspection and restores any change to them afterwards; other files, such as those git ignores, are neither restored nor reported. An effect you cause is not candidate evidence.

## checkpoint-detect
it is too large for the harness to checkpoint, so a change to it would not be restored. An effect you cause is not candidate evidence.
