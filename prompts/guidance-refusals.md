## not_attested
cc-rsi cannot attest this call: its hooks are not active in this session (run cc-rsi doctor). No verification was started.

## subagent
submit/learn are reserved for the main Actor conversation.

## role
cc-rsi tools are not available inside role contexts.

## learning_open
A learning phase is open: finish it with memory_commit, or discard it, before you submit again. Call learn to re-show the current stage message and its confirmation code; memory_commit with abandon:true discards the draft without a code.

## frozen
Memory is frozen for test-time reuse: no learning phase exists and memory cannot change.

## sealed
Memory is sealed after a sealed evaluation: learning is refused until the user records an explicit unfreeze in a terminal.

## no_terminal_verdict
learn needs a terminal Verifier verdict first: call submit (UNVERIFIED is not terminal).

## stale_verdict
The last verdict no longer covers the workspace: it changed since the inspection. Submit again so a verdict covers the current candidate.

## already_learned
This experience was already promoted to durable memory; there is nothing left to learn from it.

## quarantined
The learning phase for this verdict already ended; durable memory was not changed.

## tamper
Canonical memory changed outside a commit, so learning is refused. Ask the user to run cc-rsi memory verify in a terminal.

## bad_confirm
That confirmation code does not match the latest stage message. Read the latest stage instructions, act on them, and pass the code they give. Call learn to re-show the current stage message and its confirmation code; memory_commit with abandon:true discards the draft without a code.

## no_learning
No learning phase is open; call learn after a terminal verdict.

## unverified_not_learnable
UNVERIFIED is not a terminal verdict and cannot be learned: demonstrate the unconfirmed parts and call submit again with evidence_leads, or repair the work and submit.
