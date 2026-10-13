// `cc-rsi eval run <lineage> [--retries N] [--json-out PATH]` ★ and
// `cc-rsi eval show <lineage> [--run R]` ★ (SPEC §13.1, §13.4).
//
// Both are human-only: refused whenever CLAUDECODE is set (exit 65), so no Claude Code process, skill
// injection or model Bash call can run the official evaluator or read a score. The score is printed
// only when stdout is a TTY (lib/sealed/eval.mjs enforces it again).

import { join, resolve } from 'node:path'
import { readJsonSafe } from '../core/atomic.mjs'
import { UsageError } from '../core/errors.mjs'
import { isValidId } from '../core/ids.mjs'
import { EXIT, intOption, onlyOptions, parseArgs, projectContext, requireHuman } from './main.mjs'

const USAGE = 'usage: cc-rsi eval run <lineage> [--retries N] [--json-out PATH] | cc-rsi eval show <lineage> [--run R]'

/** The stdout handed to the sealed evaluation: io.stdout with the TTY flag of this invocation. */
function ttyAware(io) {
  return { write: text => io.stdout.write(text), isTTY: io.isTTY === true }
}

/** The project a lineage belongs to (its lineage.json; the current project first, else the only one that has it). */
async function projectOfLineage(ctx, id) {
  const { lineageDirOf } = await import('./explore.mjs')
  const lineage = await readJsonSafe(join(await lineageDirOf(ctx, id), 'lineage.json'), null)
  return lineage && typeof lineage.projectRoot === 'string' ? lineage.projectRoot : ctx.projectRoot
}

export async function run(args, io) {
  const { positionals, options } = parseArgs(args, { string: ['retries', 'json-out', 'run', 'project', 'session'] })
  const [sub, id, ...extra] = positionals
  if ((sub !== 'run' && sub !== 'show') || id === undefined || extra.length > 0) throw new UsageError(USAGE)
  requireHuman(io, `eval ${sub}`)
  onlyOptions(options, sub === 'run' ? ['retries', 'json-out', 'project', 'session'] : ['run', 'project', 'session'], `eval ${sub}`)
  if (!isValidId(id)) throw new UsageError(`invalid lineage id ${JSON.stringify(id)}`)
  const ctx = await projectContext(io, { project: options.project })
  const projectRoot = await projectOfLineage(ctx, id)
  const sealed = await import('../sealed/eval.mjs')
  if (sub === 'run') {
    const outcome = await sealed.runSealedEvaluation({
      home: ctx.home,
      projectRoot,
      lineageId: id,
      retries: options.retries === undefined ? undefined : intOption(options, 'retries', 0),
      jsonOut: options['json-out'] === undefined ? undefined : resolve(io.cwd, options['json-out']),
      stdout: ttyAware(io),
      env: io.env,
    })
    return outcome.frozenIntact === false ? EXIT.error : EXIT.ok
  }
  await sealed.showEvaluation({ home: ctx.home, projectRoot, lineageId: id, runId: options.run, stdout: ttyAware(io), env: io.env })
  return EXIT.ok
}
