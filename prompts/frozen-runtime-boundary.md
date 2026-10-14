RUNTIME BOUNDARY:
Keep supplied inputs, editable project state, required project-local dependencies,
and final deliverables inside {{PROJECT_ROOT}}, and leave it nonempty. Put
disposable caches, probes, and scratch artifacts outside it
({{SCRATCH}}), and remove any debugging debris you accidentally created inside the
root before your handoff. Never create symbolic links or special files inside the
root. Durable memory is frozen: it is read-only, and edits to your memory directory
are discarded.
