// Runtime error classes (SPEC §10.10 `errors.mjs`).
//
// Infrastructure is a separate outcome class (SPEC §2 trust boundary 3): an InfraError is never a
// PASS/FAIL, never enables learning and never commits memory. Port of dsh-rsi
// src/engine/types.ts:60-64 (InfraError / TransportInfraError), extended with the cc-rsi `cls`
// vocabulary of SPEC §10.8 so callers branch on a stable machine-readable class.

/**
 * An infrastructure outcome. `cls` is a class from SPEC §10.8 (for example `timeout`, `crash`,
 * `session_missing`, `transient_exhausted`); `detail` is a precise English sentence; `extra`
 * carries structured context (`{established}` for `session_missing`, `{livenessKey}` for
 * transport exhaustion, `{opKey}`/`{pausedAt}` added by the engine).
 */
export class InfraError extends Error {
  constructor(cls, detail, extra = {}) {
    const c = typeof cls === 'string' && cls !== '' ? cls : 'error'
    const d = detail === undefined || detail === null ? '' : String(detail)
    super(d === '' ? c : `${c}: ${d}`)
    this.name = new.target.name
    this.cls = c
    this.detail = d
    this.extra = extra && typeof extra === 'object' ? extra : {}
  }

  /** Always true; lets callers test without importing the class. */
  get infra() {
    return true
  }
}

/**
 * Transport exhaustion in a same-context conversation: `transport_liveness` (consecutive
 * actionless segments without a usable handoff) or `transport_ceiling` (the emergency segment
 * ceiling). RSIAgent `_run_handoff_phase`: no fixed retry count applies; only these two end a
 * context as infrastructure (dsh src/engine/converse.ts:5-33).
 */
export class TransportInfraError extends InfraError {}

/**
 * The invocation was stopped by the harness (`killedBy: 'stop'`, e.g. `cc-rsi explore stop`).
 * Not infrastructure and not a verdict: the context stays pending and resumable (SPEC §10.8 row 2).
 */
export class InterruptedError extends Error {
  constructor(message = 'interrupted: the harness stopped this role invocation', extra = {}) {
    super(String(message))
    this.name = 'InterruptedError'
    this.cls = 'interrupted'
    this.extra = extra && typeof extra === 'object' ? extra : {}
  }
}

/** Infra classes after which a Phase-1 branch may be restarted unscored (SPEC §10.10, §12.11). */
export const BRANCH_RETRYABLE = new Set(['crash', 'protocol', 'no_reply', 'error', 'timeout', 'context_lost'])

/** Whether `error` is an InfraError (works across module copies by duck typing on `cls` + `infra`). */
export function isInfraError(error) {
  return error instanceof InfraError || (error !== null && typeof error === 'object' && error.infra === true && typeof error.cls === 'string')
}
