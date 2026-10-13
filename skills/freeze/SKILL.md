---
name: freeze
description: Freeze the cc-rsi project memory for Phase-3 reuse (frozen lineages and sealed evaluation). Learning stays closed until a human unfreezes it in a terminal.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze`

Tell the user memory is now frozen (Phase-3 reuse); unfreezing is human-only: run `cc-rsi memory unfreeze` in a terminal.
