---
name: status
description: Show cc-rsi state for this project — memory size and integrity, frozen/sealed flags, the current task's independent-verification state, and running or paused exploration lineages. Never shows sealed evaluation scores.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status --session ${CLAUDE_SESSION_ID}`

Summarise the status above for the user in a few short lines. Do not run further commands.
