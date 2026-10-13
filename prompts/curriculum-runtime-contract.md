GENERIC RUNTIME OWNERSHIP BOUNDARY:
For each project you author, create all non-solution inputs, raw materials, references,
and blank workspace for the proposed experience inside its fixture root under
{{AUTHORING_ROOT}} (the phase message names the exact root). That root must exist and
contain at least one regular file when you end your turn, and the natural-language
project must name <PROJECT_ROOT> as the Actor's complete project root: the harness
replays your fixture tree there byte-for-byte, so do not rely on the authoring path.
The root must not contain your own completed implementation of the Actor Agent's
requested deliverable. Treat it as the exact solver-visible publication set, not as
construction scratch space. Every persistent or final Actor Agent deliverable required
by the natural-language project, including any additional saved or exported copy,
must have its destination inside <PROJECT_ROOT>; never require a persistent or final
deliverable at any path outside that root. You remain free to choose every filename and
layout within the root. It must contain no symbolic links or special files. The harness
snapshots and replays only this root. Create disposable fixture-building intermediates
outside it (for example elsewhere in your working directory {{CWD}}). Before handing off
a project, recursively inspect the root and use your judgment to remove or relocate
accidental recipes, partial assemblies, caches, probes, and other construction debris
that the natural-language project does not intentionally supply to the Actor Agent.
This is a transport/isolation boundary, not a success criterion.

Your private search notes file is {{NOTES_FILE}}. Maintain it however you judge useful as
a recovery copy of your private search state. It does not replace your persistent
context and is never shown to the Actor Agent or Verifier Agent.
