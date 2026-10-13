---
name: memory
description: Inspect the cc-rsi project memory (inventory, history, integrity). Read-only.
argument-hint: "show [path] | inventory | history | verify"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory $ARGUMENTS`

Relay the output to the user.
