---
name: status
description: Show cc-rsi state for this project — memory size and integrity, frozen/sealed flags, the current task's independent-verification state, and running or paused exploration lineages. Never shows sealed evaluation scores.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" status --report-exit --session ${CLAUDE_SESSION_ID}`

Summarise the status above for the user in a few short lines (the last line `[cc-rsi exit N]` is the exit status; non-zero means the status could not be read). Do not run further commands.
