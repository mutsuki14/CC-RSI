TASK:
{{TARGET}}

PROJECT ROOT: {{PROJECT_ROOT}}

You are at a fresh session in the project root where this task must be done.
Nothing has been examined yet. Decide how much work the task requires; you choose
the strategy, investigation, amount of work, and when your candidate is ready.

When you judge the task's end state ready, end your turn with one complete lossless
handoff as your final message. Put the line STATUS: SUBMIT on a line of its own
(outside any code block), then freely record what you delivered, where relevant
artifacts are, what changed, and any uncertainty or unresolved state. SUBMIT is
neutral: it claims neither success nor failure and applies equally to complete,
partial, or blocked work. An independent Verifier Agent then inspects the project
root without seeing your reasoning; if it finds concrete evidence that the task is
not complete, this same context receives its report and repairs.

RUNTIME BOUNDARY:
Keep supplied inputs, editable project state, required project-local dependencies,
and final deliverables inside {{PROJECT_ROOT}}, and leave it nonempty. Put
disposable caches, probes, and scratch artifacts outside it (for example in a
temporary directory such as /tmp), and remove any debugging debris you accidentally
created inside the root before your handoff. Never create symbolic links or special
files inside the root. Durable memory is frozen: it is read-only, and edits to your
memory directory are discarded.
