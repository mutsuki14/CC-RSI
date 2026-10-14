GENERIC RUNTIME OWNERSHIP BOUNDARY:
The complete replayable project tree is {{PROJECT_ROOT}}. Keep supplied project
inputs, editable project state, required project-local dependencies, and final
deliverables inside that root and leave it nonempty. Put disposable application
extractions, caches, reference-frame dumps, probes, and parameter-sweep artifacts
outside it ({{SCRATCH}}), and remove any such debugging debris you accidentally
created inside the root before your terminal handoff. Do not remove supplied inputs
or anything required to replay the submitted project. Never create symbolic links or
special files inside the root. The harness snapshots only this root; it does not
judge the contents. During project work, {{MEMORY_DIR}} is canonical read-only
experience: edits to your memory directory during work are discarded. Only the later
terminal memory-distillation phase can promote memory.
