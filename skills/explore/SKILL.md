---
name: explore
description: Start, inspect, pause or resume cc-rsi exploration lineages — Phase 1 broad waves, Phase 2 deep target/practice, Phase 3 frozen attempts — which run in the background as headless Claude Code children.
argument-hint: "preflight|start|status|log|stop|resume|show|list … (e.g. start --phase broad --direction-file ideas.md --yes)"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-rsi" explore $ARGUMENTS --session ${CLAUDE_SESSION_ID}`

Report the output above to the user faithfully. If it is a preflight, tell the user to re-run with --yes to launch. Do not poll; the user can run /cc-rsi:explore status later.
