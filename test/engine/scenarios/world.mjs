// Fake-claude scenario for engine tests: a deterministic "world" driven by `<fakeHome>/world.json`.
// Every reply depends only on the role, the message content (charters survive recovery notes, which
// embed the original message) and the session history, never on wall time, so an interrupted run
// that resumes produces the same records as an uninterrupted one (crash matrix, SPEC §15.3).
//
// world.json (all keys optional):
//   waves: [[{id, files:{rel:content}, instruction}], …]   Phase-1 wave n = waves[n-1]
//   afterWaves: 'SATURATED' | 'STALLED'                      decision once the waves run out
//   missingOnce: [id]                                         fixture not authored the first time (once)
//   deepPlan: {"<evolution>": [decision, …]}                  Phase-2 decisions per target attempt count
//   verdicts: {"<ep>"|"*": [verdict per generation]}          Verifier verdicts (last repeats)
//   verifierMutate: [ep]                                      the Verifier writes into its candidate
//   actors: {"<ep>": {…}}                                     per-episode Actor behaviour (below)
//   curriculumCrashOnce: 'before-init' | 'after-init'         first Curriculum message crashes (once)
//   curriculumAuditText: string                               appended to the first wave handoff
//   sentinel: true                                            evidence handoffs carry NARRATIVE-SENTINEL
//   summarizerApiError: {status, error}                        every summarizer-shaped call fails (auth probe)
//   delayMs: <ms>                                              every role reply sleeps first (mid-message kills)
//   loseVerifierTranscript: ep                                 the practice Verifier's stored session vanishes (once)
// actors options: stall (liveness stall unless the context is a resumed one; 'quiet' changes no file), crashOnce/crashAlways
// ('before-init'|'after-init'|…), apiErrorOnce {status, error}, hangOnce <ms>, emptyRootOnce,
// extraMemoryFiles <n>, concurrentCommitOnce (another session commits during distillation),
// apiErrorAt {marker, error} (once, on the first message containing marker), noActionWork. "Once" behaviours are keyed by the episode without its -a<n> restart suffix.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function world(ctx) {
  try { return JSON.parse(readFileSync(join(ctx.fakeHome, 'world.json'), 'utf8')) } catch { return {} }
}

/** True the first time `name` is asked for in this fake home (a durable once-marker). */
function once(ctx, name) {
  const marker = join(ctx.fakeHome, `once-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
  if (existsSync(marker)) return false
  writeFileSync(marker, 'x')
  return true
}

function observe(ctx, record) {
  appendFileSync(join(ctx.fakeHome, 'observations.jsonl'), `${JSON.stringify({ ...record, role: ctx.role, session: ctx.sessionId, turn: ctx.turn })}\n`)
}

/** The message plus every earlier prompt of this session, newest first. */
function prompts(ctx) {
  return [ctx.prompt, ...[...(ctx.history ?? [])].reverse().map(t => t?.prompt ?? '').filter(Boolean)]
}

function lastWith(ctx, marker) {
  return prompts(ctx).find(p => p.includes(marker)) ?? ''
}

const baseOf = ep => String(ep).replace(/-a\d+$/, '')

function lookup(map, ep) {
  if (!map) return undefined
  return map[ep] ?? map[baseOf(ep)] ?? map['*']
}

function listFiles(dir) {
  const out = []
  const visit = (d, rel) => {
    let names = []
    try { names = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) visit(join(d, e.name), r)
      else out.push(r)
    }
  }
  visit(dir, '')
  return out
}

// ---------------------------------------------------------------------------------------- Curriculum

function curriculum(ctx, w) {
  if (w.curriculumCrashOnce && once(ctx, 'curriculum-crash')) return { crash: w.curriculumCrashOnce }
  const waveCharter = lastWith(ctx, 'PERSISTENT PHASE-1 PARALLEL SEARCH')
  const deepCharter = lastWith(ctx, 'PERSISTENT OUTER-LOOP META-SEARCH (PHASE 2)')
  const isWave = ctx.prompt.includes('PERSISTENT PHASE-1 PARALLEL SEARCH') || ctx.prompt.includes('SAME-CONTEXT WAVE CONTINUATION')
    || (!ctx.prompt.includes('PHASE 2') && waveCharter !== '' && deepCharter === '')
  if (isWave) {
    const prior = [...waveCharter.matchAll(/WAVE (\d+) CURRICULUM RATIONALE:/g)].map(m => Number(m[1]))
    const n = prior.length === 0 ? 1 : Math.max(...prior) + 1
    const projects = (w.waves ?? [])[n - 1]
    if (!projects) {
      const decision = w.afterWaves ?? 'SATURATED'
      return { text: `Coverage looks complete.\n\n\`\`\`json\n${JSON.stringify({ decision, rationale: `${decision.toLowerCase()} after ${n - 1} waves`, projects: [] })}\n\`\`\`` }
    }
    const authoring = join(ctx.cwd, 'authoring')
    const actions = []
    for (const p of projects) {
      if ((w.missingOnce ?? []).includes(p.id) && once(ctx, `missing-${n}-${p.id}`)) continue
      for (const [rel, content] of Object.entries(p.files ?? { 'input.txt': `${p.id}\n` })) {
        actions.push({ tool: 'Write', file_path: join(authoring, p.id, rel), content })
      }
    }
    const envelope = { decision: 'WAVE', rationale: `explore wave ${n}`, projects: projects.map(p => ({ id: p.id, instruction: p.instruction ?? `In <PROJECT_ROOT> transform input.txt into ${p.id}.out.` })) }
    const extra = n === 1 && w.curriculumAuditText ? `\n\n${w.curriculumAuditText}` : ''
    return { actions, text: `Wave ${n} authored.${extra}\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\`` }
  }
  // Phase 2 decision: evolution = number of target attempts so far; index = practice since the last one.
  const charter = deepCharter || ctx.prompt
  const lines = charter.split('\n')
  const evolution = lines.filter(l => /^- Phase-2 target attempt \d+:/.test(l)).length
  const lastTarget = lines.map((l, i) => (/^- Phase-2 target attempt \d+:/.test(l) ? i : -1)).filter(i => i >= 0).pop() ?? -1
  const sincePractice = lines.slice(lastTarget + 1).filter(l => /^- Phase-2 practice project p\d+:/.test(l)).length
  const plan = (w.deepPlan ?? {})[String(evolution)] ?? []
  const decision = plan[sincePractice] ?? 'READY_FOR_TARGET'
  if (decision === 'PROJECT') {
    const authoring = join(ctx.cwd, 'practice', 'authoring')
    return {
      actions: [{ tool: 'Write', file_path: join(authoring, 'data.txt'), content: 'a;b\n1;2\n' }],
      text: 'Practice the delimiter handling.\nDECISION: PROJECT\nIn <PROJECT_ROOT> convert data.txt (semicolon-delimited) into data.json.',
    }
  }
  return { actions: [{ tool: 'Read', file_path: join(ctx.cwd, 'notes.md') }], text: `Decision after evolution ${evolution}.\nDECISION: ${decision}` }
}

// ---------------------------------------------------------------------------------------- Actor

/**
 * Simulates another learner (an interactive session) promoting memory while this Actor learns: a
 * real store commit through the plugin's MemoryStore, so the engine's commit sees a conflict.
 */
async function concurrentCommit(ctx) {
  const W = dirname(dirname(ctx.cwd))
  const key = basename(dirname(W))
  const home = ctx.env.CC_RSI_HOME
  const { MemoryStore } = await import(new URL('../../../lib/memory/store.mjs', import.meta.url).href)
  const projects = join(home, 'projects', key)
  const store = await MemoryStore.open(join(projects, 'store'), { sessionsDir: join(projects, 'sessions'), lineagesDir: join(projects, 'lineages') })
  try {
    const dir = join(ctx.fakeHome, 'concurrent-draft')
    await store.openDraft('concurrent-session-1', { dir, fresh: true, owner: { kind: 'session', sessionId: 'concurrent' } })
    writeFileSync(join(dir, 'from-another-session.md'), 'promoted meanwhile\n')
    await store.commit('concurrent-session-1', { kind: 'task', outcome: 'PASS' })
  } finally {
    await store.close()
  }
}

/** Deletes the stored sessions of the Verifier(s) of `ep` (a transcript pruned by cleanupPeriodDays). */
function loseVerifierTranscripts(ctx, ep) {
  const dir = join(ctx.fakeHome, 'sessions')
  for (const name of readdirSync(dir)) {
    try {
      const session = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const first = session.turns?.[0]?.prompt ?? ''
      if (first.includes('VERIFIER AGENT') && first.includes(`/verify/${ep}/candidate`)) rmSync(join(dir, name), { force: true })
    } catch {
      // not a session file
    }
  }
}

async function actor(ctx, w) {
  const ep = basename(ctx.cwd)
  const base = baseOf(ep)
  const conf = lookup(w.actors, ep) ?? {}
  const memoryDir = join(ctx.cwd, '..', '..', 'actor-private', ep, 'memory')
  const p = ctx.prompt
  if (conf.crashAlways) return { crash: conf.crashAlways }
  if (conf.crashOnce && once(ctx, `actor-crash-${base}`)) return { crash: conf.crashOnce }
  if (conf.apiErrorOnce && once(ctx, `actor-api-${base}`)) return { apiError: conf.apiErrorOnce }
  if (conf.hangOnce && once(ctx, `actor-hang-${base}`)) return { hangMs: conf.hangOnce, text: 'late' }
  if (conf.apiErrorAt && p.includes(conf.apiErrorAt.marker) && once(ctx, `actor-api-at-${base}`)) return { apiError: conf.apiErrorAt.error }
  if (p.includes('FINAL MEMORY DISTILLATION')) {
    if (conf.concurrentCommitOnce && once(ctx, `concurrent-${base}`)) await concurrentCommit(ctx)
    // Idempotent like a real Actor told "if you already acted, continue": its own files are not news.
    const seen = listFiles(memoryDir).filter(f => f !== `lesson-${base}.md` && !f.startsWith(`extra-${base}-`))
    observe(ctx, { kind: 'distill', ep, seen, phaseWritable: true })
    const actions = [{ tool: 'Write', file_path: join(memoryDir, `lesson-${base}.md`), content: `lesson from ${base}\nseen before: ${seen.join(', ') || '(none)'}\n` }]
    for (let i = 1; i <= (conf.extraMemoryFiles ?? 0); i++) actions.push({ tool: 'Write', file_path: join(memoryDir, `extra-${base}-${i}.md`), content: `extra ${i}\n` })
    return { actions, text: 'Draft memory written.' }
  }
  if (p.includes('MEMORY LIMITS')) {
    const extras = listFiles(memoryDir).filter(f => f.startsWith('extra-'))
    return { actions: extras.map(f => ({ tool: 'Bash', command: `rm -f ${JSON.stringify(join(memoryDir, f))}` })), text: 'Condensed.' }
  }
  if (p.includes('MEMORY CONFLICT')) {
    const prev = `${memoryDir}.prev`
    const actions = listFiles(prev).filter(f => f.startsWith('lesson-')).map(f => ({ tool: 'Write', file_path: join(memoryDir, f), content: readFileSync(join(prev, f), 'utf8') }))
    return { actions, text: 'Re-applied my draft.' }
  }
  if (p.includes('TERMINAL MEMORY RECONCILIATION')) return { actions: [{ tool: 'Glob', pattern: '**', path: memoryDir }], text: 'Reconciled.' }
  if (p.includes('FREE-FORM LEARNING DIAGNOSIS')) return { text: `diagnosis for ${base}: the delimiter handling is the uncertainty` }
  if (p.includes('could not CONFIRM')) {
    if (w.loseVerifierTranscript === base && once(ctx, `lose-verifier-${base}`)) loseVerifierTranscripts(ctx, ep)
    const sentinel = w.sentinel ? 'NARRATIVE-SENTINEL this narrative must never reach the Verifier\n' : ''
    return {
      actions: [{ tool: 'Write', file_path: join(ctx.cwd, 'evidence.txt'), content: `evidence for ${base}\n` }],
      text: `STATUS: SUBMIT\n${sentinel}CLAIM: the output file exists\nPROBE: test -f out.txt && echo PASS`,
    }
  }
  if (p.includes('found concrete evidence that the task is NOT complete')) {
    return { actions: [{ tool: 'Write', file_path: join(ctx.cwd, 'fixed.txt'), content: `fixed ${base}\n` }], text: 'Repaired.\nSTATUS: SUBMIT' }
  }
  // Work phase (practice charter, target/frozen opening, resume opening, transport/stall continuations).
  if (conf.stall) {
    // A context that never hands off: one acting segment, then actionless ones (liveness stall).
    // A resumed fresh context (its opening says it continues the attempt) works normally.
    const opening = (ctx.history ?? []).find(t => t && t.prompt)?.prompt ?? ctx.prompt
    if (!opening.includes('continuing this target attempt')) {
      const first = !(ctx.history ?? []).some(t => t && !t.interrupted)
      if (first && conf.stall === 'quiet') return { actions: [{ tool: 'Glob', pattern: '**', path: ctx.cwd }], text: 'Looking around.' }
      if (first) return { actions: [{ tool: 'Write', file_path: join(ctx.cwd, 'partial.txt'), content: 'half\n' }], text: 'Thinking about it.' }
      return { text: 'Still thinking.' }
    }
  }
  if (conf.noActionWork) return { text: 'Work complete.\nSTATUS: SUBMIT' }
  if (conf.emptyRootOnce && once(ctx, `empty-root-${base}`)) {
    return { actions: [{ tool: 'Bash', command: 'rm -rf ./* ./.[!.]* 2>/dev/null; true' }], text: 'Cleaned up.\nSTATUS: SUBMIT' }
  }
  return { actions: [{ tool: 'Write', file_path: join(ctx.cwd, 'out.txt'), content: `result for ${base}\n` }], text: `Work on ${base} is complete.\nSTATUS: SUBMIT` }
}

// ---------------------------------------------------------------------------------------- Verifier

function verifier(ctx, w) {
  const charter = lastWith(ctx, 'CANDIDATE ROOT:')
  const root = (/CANDIDATE ROOT: (.+)/.exec(charter) ?? [])[1]?.trim() ?? ctx.cwd
  const practice = basename(root) === 'candidate'
  const ep = practice ? basename(dirname(root)) : basename(root)
  const W = practice ? dirname(dirname(dirname(root))) : dirname(dirname(root))
  const gen = Number((/candidate generation (\d+)/.exec(charter) ?? [])[1] ?? 1)
  const list = lookup(w.verdicts, ep) ?? ['PASS']
  const verdict = list[Math.min(gen, list.length) - 1]
  observe(ctx, {
    kind: 'inspect',
    ep,
    gen,
    cwd: ctx.cwd,
    model: ctx.model,
    actorMemoryExists: existsSync(join(W, 'actor-private', ep, 'memory')),
    candidateHasMemoryDir: existsSync(join(ctx.cwd, 'memory')),
    leads: charter.includes('LEAD 1'),
    narrativeLeak: charter.includes('NARRATIVE-SENTINEL'),
    handoverReports: charter.includes('PUBLISHED REPORTS OF THE EARLIER VERIFIER CONTEXT'),
    otherVerifier: charter.includes('You are a fresh Verifier context on a different model'),
    originalFixtures: charter.includes(join(W, 'verify', ep, 'original')),
    unverifiedAllowed: charter.includes('VERDICT: UNVERIFIED'),
  })
  const actions = [{ tool: 'Bash', command: 'ls -1' }]
  if ((w.verifierMutate ?? []).includes(ep)) actions.push({ tool: 'Bash', command: 'echo tampered > tampered-by-verifier.txt' })
  return { actions, text: `Inspection of ${baseOf(ep)} generation ${gen}.\nVERDICT: ${verdict}` }
}

// ---------------------------------------------------------------------------------------- dispatch

async function reply(ctx, w) {
  if (ctx.role === 'curriculum') return curriculum(ctx, w)
  if (ctx.role === 'actor') return actor(ctx, w)
  if (ctx.role === 'verifier') return verifier(ctx, w)
  return null
}

export default async function respond(ctx) {
  const w = world(ctx)
  const r = await reply(ctx, w)
  if (r) {
    // delayMs: every reply sleeps first (a window for crash tests to kill the engine mid-message).
    if (Number.isFinite(w.delayMs) && w.delayMs > 0 && !r.crash && !r.apiError && !r.hangMs) return { ...r, hangMs: w.delayMs }
    return r
  }
  if (ctx.role === 'summarizer') {
    if (w.summarizerApiError) return { apiError: w.summarizerApiError }
    if (ctx.prompt.includes('A task attempt just stalled')) return { text: 'REVIEW: try a different entry point.' }
    if (ctx.prompt.includes('OLDER TURNS TO FOLD IN')) return { text: 'WORK LOG: partial.txt was written; no handoff.' }
    return { text: 'OK' }
  }
  mkdirSync(ctx.fakeHome, { recursive: true })
  return { text: 'OK' }
}
