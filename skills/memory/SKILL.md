---
name: memory
description: Inspect the cc-rsi project memory (inventory, history, integrity). Read-only.
argument-hint: "show [path] | inventory | history | verify"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory --report-exit $ARGUMENTS`

Relay the output to the user. Its last line `[cc-rsi exit N]` is the exit status: 0 ok, 1 error (for verify: tampered memory, see the remedy above), 2 usage, 3 refused, 65 human-only (the user must run it in a terminal).
