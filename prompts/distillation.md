## main
ACTOR AGENT — FINAL MEMORY DISTILLATION.

This is the terminal learning turn for the project in your same Actor Agent
context. The terminal outcome is {{OUTCOME}}. {{OUTCOME_MEANING}}

FINAL VERIFIER AGENT REPORT — verbatim:
---
{{REPORT}}
---

Review the complete experience available in your context: your decisions, actions,
observations, the Verifier Agent's investigation, and the terminal outcome. Decide
for yourself what this experience means for future work. The Verifier Agent
establishes what was or was not verified; it does not establish why your approach
succeeded or failed. Make causal claims only when your trajectory and evidence
support them, and preserve uncertainty where they do not.

Update your durable memory at {{MEMORY_DIR}} in whatever way you judge will make a
fresh future Actor Agent more capable. You may investigate remaining questions if
the available project state makes that useful, and you may add, revise, reorganize,
delete, or leave memory unchanged. You own the content, representation, retrieval
strategy, scope, and stopping decision; there is no required schema, length,
number of files, or number of turns. A FAIL may still contain valuable evidence,
but must not be recorded as a verified success.

The memory store accepts at most {{MAX_FILES}} files, {{MAX_TOTAL_BYTES}} bytes in total, and
{{MAX_FILE_BYTES}} bytes per file. Never store secrets in memory.

Do not continue changing the terminal project for credit. {{TAIL}}

## pass
The Verifier Agent has verified the complete project.

## fail
The Verifier Agent returned FAIL; no success was verified.
