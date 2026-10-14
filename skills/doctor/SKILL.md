---
name: doctor
description: Diagnose the cc-rsi installation — Node, Claude Code version and flags, git, the ~/.cc-rsi home and terminal shim, memory integrity, workspace locks, lineages, the OS sandbox, hooks, the MCP server, models and configuration. --live adds tiny authentication, hook and sandbox probes.
argument-hint: "[--live]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" doctor *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" doctor --report-exit $ARGUMENTS --session ${CLAUDE_SESSION_ID}`

The last line `[cc-rsi exit N]` is the command's exit status (0: no check failed; 1: at least one FAIL). Explain each FAIL/WARN and its remedy.
