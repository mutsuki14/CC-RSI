---
name: freeze
description: Freeze the cc-rsi project memory for Phase-3 reuse (frozen lineages and sealed evaluation). Learning stays closed until a human unfreezes it in a terminal.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze --report-exit)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" memory freeze --report-exit`

The last line `[cc-rsi exit N]` is the exit status. On exit 0 tell the user memory is now frozen (Phase-3 reuse); unfreezing is human-only: run `cc-rsi memory unfreeze` in a terminal. Otherwise memory was not frozen: relay the reason above.
