// Error base classes shared by every cc-rsi package (SPEC §5.3).
//
// Every cc-rsi error carries a stable machine-readable `code` and a `details`
// object. The constructor is `(code, message, details = {})`. The subclasses
// below also accept a shorter form (documented on each class) so callers can
// throw them without repeating their fixed code and message.

/** Base class: `new CcRsiError(code, message, details = {})`. */
export class CcRsiError extends Error {
  constructor(code, message, details = {}) {
    super(message === undefined || message === null ? String(code) : String(message))
    this.name = new.target.name
    this.code = code
    this.details = details && typeof details === 'object' ? details : {}
  }
}

/** Whether `args` uses the full `(code, message, details?)` form. */
function fullForm(args) {
  return args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'string'
}

/**
 * Bad command-line usage (CLI exit code 2).
 * Forms: `new UsageError(message)` or `new UsageError(code, message, details)`.
 */
export class UsageError extends CcRsiError {
  constructor(...args) {
    if (fullForm(args)) super(args[0], args[1], args[2])
    else super('usage', args[0] ?? 'usage error', args[1])
    this.exitCode = 2
  }
}

/**
 * A lease lock could not be acquired within its wait budget.
 * Forms: `new LockTimeoutError(message, details?)` or `new LockTimeoutError(code, message, details)`.
 */
export class LockTimeoutError extends CcRsiError {
  constructor(...args) {
    if (fullForm(args)) super(args[0], args[1], args[2])
    else super('lock_timeout', args[0] ?? 'timed out waiting for a lock', args[1])
  }
}

/**
 * A human-only command was run inside Claude Code (CLAUDECODE is set; CLI exit code 65).
 * Forms: `new HumanOnlyError(cmd, details?)` → the fixed message naming `cmd`;
 * `new HumanOnlyError(code, cmd, details?)` → the same with a custom code;
 * `new HumanOnlyError(code, 'cc-rsi: …full message', details?)` → the message as given.
 */
export class HumanOnlyError extends CcRsiError {
  constructor(...args) {
    const message = cmd => `cc-rsi: "${cmd}" is human-only: run it in a terminal outside Claude Code`
    if (fullForm(args)) super(args[0], args[1].startsWith('cc-rsi:') ? args[1] : message(args[1]), args[2])
    else super('human_only', message(args[0] === undefined ? 'this command' : String(args[0])), args[1])
    this.exitCode = 65
  }
}

/**
 * Refusal to run inside a cc-rsi role child (CC_RSI_ROLE is set; CLI exit code 64).
 * Forms: `new RoleContextError(details?)` or `new RoleContextError(code, message, details)`.
 */
export class RoleContextError extends CcRsiError {
  constructor(...args) {
    if (fullForm(args)) super(args[0], args[1], args[2])
    else super('role_context', 'cc-rsi: refusing to run inside a cc-rsi role context (CC_RSI_ROLE is set)', args[0])
    this.exitCode = 64
  }
}
