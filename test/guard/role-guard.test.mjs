// SPEC §10.6 / §15.3 WP4 `role-guard.test.mjs`: spawns hooks/role-guard.mjs with synthetic payloads: digest
// pass/block; hidden path deny incl. `..` through a symlink; search root above a hidden root; write outside
// writeRoots; Bash hidden tokens, allowedPaths masking, recursion, mutation patterns; property test: 500 random
// payloads never yield allow; malformed input → deny; guard log written before output; REPEAT liveness note; pin.

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../lib/core/digest.mjs'
import { MUTATION_BASH_DENY } from '../../lib/guard/bash.mjs'
import { runNode } from '../_helpers/spawn.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'role-guard.mjs')

async function world(policyExtra = {}) {
  const base = await tmpDir('cc-rsi-guard-')
  const W = join(base, 'work', 'proj', 'lin')
  const dirs = {
    base,
    W,
    cwd: join(W, 'projects', 'w001'),
    other: join(W, 'projects', 'w002'),
    memdir: join(W, 'actor-private', 'w001', 'memory'),
    curriculum: join(W, 'curriculum-private'),
    verify: join(W, 'verify'),
    home: join(base, 'cc-rsi-home'),
    userHome: join(base, 'user'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  writeFileSync(join(dirs.other, 'secret.txt'), 'OTHER')
  writeFileSync(join(dirs.cwd, 'main.py'), 'print(1)\n')
  const policy = {
    v: 1,
    role: 'actor',
    ctxKey: 'w001/actor',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    cwd: dirs.cwd,
    home: dirs.home,
    userHome: dirs.userHome,
    readRoots: [dirs.cwd, dirs.memdir],
    writeRoots: [dirs.cwd],
    readOnlyRoots: [dirs.memdir],
    hidden: [dirs.curriculum, dirs.verify, dirs.other, join(dirs.home, 'projects'), join(dirs.userHome, '.claude', 'projects')],
    hiddenTokens: ['curriculum-private', 'verify-scratch', '/verify/', '/.cc-rsi/projects', '.claude/projects'],
    allowedPaths: [dirs.cwd, dirs.memdir],
    bashDeny: [],
    recursionGuard: true,
    foreignMessageGuard: true,
    liveness: true,
    pinFile: null,
    stagnationRevisit: '\n\nSTAGNATION REVISIT TEXT',
    repeatWarning: 'WARNING: you ran the IDENTICAL command as last turn',
    ...policyExtra,
  }
  const policyFile = join(base, 'policy.json')
  writeFileSync(policyFile, JSON.stringify(policy))
  const guardLog = join(base, 'guard.jsonl')
  const env = { ...process.env, CC_RSI_POLICY: policyFile, CC_RSI_GUARD_LOG: guardLog, CC_RSI_EXPECT: sha256Hex('the harness message\n'), CC_RSI_ROLE: 'actor' }
  const run = async (mode, payload, extraEnv = {}) => {
    const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const r = await runNode(GUARD, [mode], { stdin, env: { ...env, ...extraEnv }, cwd: dirs.cwd })
    assert.ok(!/"permissionDecision"\s*:\s*"allow"/.test(r.stdout), `the guard printed allow: ${r.stdout}`)
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }
  }
  const tool = (tool_name, tool_input, extra = {}) => run('tool', { session_id: 's', cwd: dirs.cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: `toolu_${Math.random().toString(16).slice(2)}`, ...extra })
  const logLines = () => {
    try {
      return readFileSync(guardLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { dirs, policy, policyFile, guardLog, env, run, tool, logLines }
}

const decisionOf = r => r.json?.hookSpecificOutput?.permissionDecision ?? 'pass'
const reasonOf = r => r.json?.hookSpecificOutput?.permissionDecisionReason ?? ''

test('prompt: the harness digest passes silently; any other prompt is blocked', async () => {
  const w = await world()
  const pass = await w.run('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'the harness message\n' })
  assert.equal(pass.code, 0)
  assert.equal(pass.stdout, '')
  const block = await w.run('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'the harness message' })
  assert.deepEqual(block.json, { decision: 'block', reason: 'cc-rsi: messages from outside the harness are refused' })
  const malformed = await w.run('prompt', 'not json')
  assert.equal(malformed.json.decision, 'block')
  const log = w.logLines()
  assert.deepEqual(log.map(e => [e.hook, e.decision]), [['prompt', 'pass'], ['prompt', 'block'], ['prompt', 'block']])
  assert.equal(log[0].digest, sha256Hex('the harness message\n'))
  // the escape hatch: foreignMessageGuard false
  const off = await world({ foreignMessageGuard: false })
  assert.equal((await off.run('prompt', { prompt: 'anything' })).stdout, '')
})

test('tool: a tool outside the role is denied', async () => {
  const w = await world()
  const r = await w.tool('WebFetch', { url: 'https://example.com' })
  assert.equal(decisionOf(r), 'deny')
  assert.equal(reasonOf(r), 'WebFetch is not available to this role')
})

test('tool: hidden paths are denied, including `..` through a symlink', async () => {
  const w = await world()
  const r1 = await w.tool('Read', { file_path: join(w.dirs.other, 'secret.txt') })
  assert.equal(decisionOf(r1), 'deny')
  assert.match(reasonOf(r1), /is a harness-private path hidden from this role; it is not candidate evidence\.$/)
  // cwd/link → W/projects/w002/sub ; cwd/link/../secret.txt is lexically cwd/secret.txt but physically w002/secret.txt
  mkdirSync(join(w.dirs.other, 'sub'), { recursive: true })
  symlinkSync(join(w.dirs.other, 'sub'), join(w.dirs.cwd, 'link'))
  const r2 = await w.tool('Read', { file_path: `${w.dirs.cwd}/link/../secret.txt` })
  assert.equal(decisionOf(r2), 'deny')
  const r3 = await w.tool('Read', { file_path: 'link/../secret.txt' })
  assert.equal(decisionOf(r3), 'deny', 'relative spellings resolve against the payload cwd')
  const r4 = await w.tool('Read', { file_path: join(w.dirs.cwd, 'main.py') })
  assert.equal(decisionOf(r4), 'pass')
})

test('tool: the role\'s own directories stay usable inside a broader hidden root', async () => {
  const w0 = await world()
  const w = await world({ hidden: [w0.dirs.W], allowedPaths: [w0.dirs.cwd], readRoots: [w0.dirs.cwd, w0.dirs.other], cwd: w0.dirs.cwd })
  assert.equal(decisionOf(await w.tool('Read', { file_path: join(w0.dirs.cwd, 'main.py') })), 'pass')
  assert.equal(decisionOf(await w.tool('Read', { file_path: join(w0.dirs.other, 'secret.txt') })), 'deny')
})

test('tool: a search rooted above a hidden root is denied; Glob patterns that climb are seen', async () => {
  const w = await world()
  assert.equal(decisionOf(await w.tool('Grep', { pattern: 'x', path: join(w.dirs.W, 'projects') })), 'deny')
  assert.match(reasonOf(await w.tool('Glob', { pattern: '**/*', path: w.dirs.W })), /narrow the search path/)
  assert.equal(decisionOf(await w.tool('Glob', { pattern: '../w002/**' })), 'deny')
  assert.equal(decisionOf(await w.tool('Glob', { pattern: `${w.dirs.other}/**/*.txt` })), 'deny')
  assert.equal(decisionOf(await w.tool('Grep', { pattern: 'print' })), 'pass', 'the default search root is cwd')
  assert.equal(decisionOf(await w.tool('Glob', { pattern: '**/*.py', path: w.dirs.cwd })), 'pass')
})

test('tool: reads outside readRoots, writes outside writeRoots and writes to read-only roots are denied', async () => {
  const w = await world()
  assert.match(reasonOf(await w.tool('Read', { file_path: '/etc/hostname' })), /outside the directories available to this role/)
  assert.equal(decisionOf(await w.tool('Read', { file_path: join(w.dirs.memdir, 'INDEX.md') })), 'pass')
  assert.match(reasonOf(await w.tool('Write', { file_path: join(w.dirs.memdir, 'INDEX.md'), content: 'x' })), /is not writable by this role/)
  assert.match(reasonOf(await w.tool('Write', { file_path: join(w.dirs.base, 'escape.txt'), content: 'x' })), /outside|not writable/)
  assert.equal(decisionOf(await w.tool('Edit', { file_path: join(w.dirs.cwd, 'main.py'), old_string: '1', new_string: '2' })), 'pass')
  assert.equal(decisionOf(await w.tool('Write', { file_path: join(w.dirs.cwd, 'new', 'file.py'), content: 'x' })), 'pass')
  assert.match(reasonOf(await w.tool('Read', {})), /without a file_path/)
})

test('tool: a Verifier (no write roots) may never write', async () => {
  const w = await world({ role: 'verifier', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'NotebookEdit'], writeRoots: [], readOnlyRoots: [] })
  assert.equal(decisionOf(await w.tool('Write', { file_path: join(w.dirs.cwd, 'x.txt'), content: 'x' })), 'deny')
  assert.match(reasonOf(await w.tool('NotebookEdit', { notebook_path: join(w.dirs.cwd, 'n.ipynb'), new_source: 'x' })), /is not writable by this role/)
})

test('Bash: hidden paths, ~ and $HOME spellings, relative traversal and hidden tokens', async () => {
  const w = await world()
  const denied = [
    `cat ${w.dirs.other}/secret.txt`,
    'cat ../w002/secret.txt',
    'cd .. && cat w002/secret.txt',
    'ls ~/.claude/projects',
    'ls $HOME/.claude/projects/x',
    'ls "${HOME}/.claude/projects"',
    `ls $CC_RSI_HOME/projects`,
    'grep -r x ../../curriculum-private',
    'cat /x/verify-scratch/t001-v1/notes',
    `ls ${w.dirs.W}/verify/`,
    `cat ${w.dirs.other.slice(0, -1)}"${w.dirs.other.slice(-1)}"/secret.txt`,
  ]
  for (const command of denied) assert.equal(decisionOf(await w.tool('Bash', { command })), 'deny', command)
  const allowed = ['ls -la', 'python3 main.py', `cat ${w.dirs.cwd}/main.py`, `ls ${w.dirs.memdir}`, 'git status && git diff --stat', 'echo "a/b" | sed s/a/b/', 'ls ..']
  for (const command of allowed) assert.equal(decisionOf(await w.tool('Bash', { command })), 'pass', command)
})

test('Bash: allowedPaths are masked before the token check', async () => {
  const own = join('/x/W', 'verify', 'w001', 'candidate')
  const w = await world({ role: 'verifier', allowedPaths: [own], hiddenTokens: ['/verify/'], hidden: [], readRoots: [own] })
  assert.equal(decisionOf(await w.tool('Bash', { command: `ls ${own} && cat ${own}/a.txt` })), 'pass')
  assert.equal(decisionOf(await w.tool('Bash', { command: 'ls /x/W/verify/w002/candidate' })), 'deny')
})

test('Bash: recursion into Claude Code or cc-rsi is refused', async () => {
  const w = await world()
  for (const command of ['claude -p hi', 'cc-rsi status', '/usr/local/bin/claude --version', 'node /opt/plugin/bin/cc-rsi explore start', 'nodejs ./lib/cli/main.mjs/cc-rsi',
    'npx @anthropic-ai/claude-code -p hi', 'pnpm dlx @anthropic-ai/claude-code', 'FOO=1 env -u X timeout 5 nice -n 3 claude', 'echo "$(claude -p x)"', 'bash -c "claude -p x"',
    'true && sudo -u root cc-rsi eval run', 'find . -exec claude {} \\;', 'eval claude']) {
    const r = await w.tool('Bash', { command })
    assert.equal(decisionOf(r), 'deny', command)
    assert.match(reasonOf(r), /recursion is refused/, command)
  }
  for (const command of ['echo claude', 'grep -r claude .', 'cat claude.md', 'git log --author=claude']) {
    assert.equal(decisionOf(await w.tool('Bash', { command })), 'pass', command)
  }
})

test('Bash: the external-mutation patterns of a non-sandboxed Verifier', async () => {
  const w = await world({ role: 'verifier', bashDeny: MUTATION_BASH_DENY })
  for (const command of ['git push origin main', 'git -C repo push', 'git remote set-url origin x', 'curl -X POST https://api.example.com', 'curl -d a=b https://x',
    'curl --data @f https://x', 'wget --post-data=a https://x', 'ssh host ls', 'scp a host:b', 'rsync -a . host:/x', 'sudo rm -rf /', 'kill -9 1', 'docker rm c', 'docker container stop c',
    'kubectl delete pod x', 'kubectl apply -f x.yaml']) {
    const r = await w.tool('Bash', { command })
    assert.equal(decisionOf(r), 'deny', command)
    assert.match(reasonOf(r), /cannot be rolled back/, command)
  }
  for (const command of ['git status', 'git log -1', 'curl https://example.com', 'curl -s -o out.html https://example.com', 'rsync -a src/ dst/', 'docker ps', 'kubectl get pods']) {
    assert.equal(decisionOf(await w.tool('Bash', { command })), 'pass', command)
  }
})

test('malformed input and a broken policy fail closed; the guard log is written before output', async () => {
  const w = await world()
  for (const stdin of ['', 'not json', '[]', '{"tool_name": 5}', 'null']) {
    const r = await w.run('tool', stdin)
    assert.equal(decisionOf(r), 'deny', JSON.stringify(stdin))
    assert.equal(r.code, 0)
  }
  const broken = await w.run('tool', { tool_name: 'Read', tool_input: { file_path: join(w.dirs.cwd, 'main.py') }, tool_use_id: 't' }, { CC_RSI_POLICY: join(w.dirs.base, 'missing.json') })
  assert.equal(decisionOf(broken), 'deny')
  // A log that cannot be written means no attestation: even a passing call is denied.
  const unlogged = await w.run('tool', { tool_name: 'Read', tool_input: { file_path: join(w.dirs.cwd, 'main.py') }, tool_use_id: 't' }, { CC_RSI_GUARD_LOG: w.dirs.cwd })
  assert.equal(decisionOf(unlogged), 'deny')
  const before = w.logLines().length
  const r = await w.tool('Read', { file_path: join(w.dirs.cwd, 'main.py') })
  assert.equal(decisionOf(r), 'pass')
  const after = w.logLines()
  assert.equal(after.length, before + 1)
  assert.equal(after[after.length - 1].hook, 'tool')
  assert.equal(after[after.length - 1].decision, 'pass')
  assert.equal((await w.run('bogus', {})).code, 2)
})

test('post: the REPEAT note for an identical command and output (+ stagnation revisit once); never blocking', async () => {
  const w = await world()
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make test' }, tool_response: { stdout: 'FAIL 3', stderr: '' }, tool_use_id: 'a' }
  assert.equal((await w.run('post', payload)).stdout, '')
  const second = await w.run('post', { ...payload, tool_use_id: 'b' })
  assert.equal(second.json.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.equal(second.json.hookSpecificOutput.additionalContext, 'WARNING: you ran the IDENTICAL command as last turn\n\nSTAGNATION REVISIT TEXT')
  const third = await w.run('post', { ...payload, tool_use_id: 'c' })
  assert.equal(third.json.hookSpecificOutput.additionalContext, 'WARNING: you ran the IDENTICAL command as last turn')
  const described = await w.run('post', { ...payload, tool_input: { command: 'make test', description: 'Run the tests again' } })
  assert.match(described.json.hookSpecificOutput.additionalContext, /IDENTICAL/, 'the cosmetic Bash description is ignored')
  assert.equal((await w.run('post', { ...payload, tool_response: { stdout: 'PASS', stderr: '' } })).stdout, '', 'changed output is not a repeat')
  assert.equal((await w.run('post', 'garbage')).code, 0)
  const off = await world({ liveness: false })
  await off.run('post', payload)
  assert.equal((await off.run('post', payload)).stdout, '')
})

test('pin: prints the pin file (≤ 9000 chars) as SessionStart additionalContext', async () => {
  const base = await tmpDir('cc-rsi-pin-')
  const pinFile = join(base, 'pin.md')
  writeFileSync(pinFile, `TASK (verbatim):\n${'x'.repeat(10000)}`)
  const w = await world({ pinFile })
  const r = await w.run('pin', { hook_event_name: 'SessionStart', source: 'compact' })
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(r.json.hookSpecificOutput.additionalContext.length, 9000)
  assert.ok(r.json.hookSpecificOutput.additionalContext.startsWith('TASK (verbatim):'))
  assert.ok(w.logLines().some(e => e.hook === 'pin'))
  const none = await world({ pinFile: null })
  assert.equal((await none.run('pin', {})).stdout, '')
})

test('property: 500 random payloads never yield allow and always answer with valid JSON or nothing', async () => {
  const w = await world({ bashDeny: MUTATION_BASH_DENY })
  let seed = 0x5eed
  const rand = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const pick = list => list[rand(list.length)]
  const paths = [w.dirs.cwd, join(w.dirs.cwd, 'main.py'), w.dirs.other, join(w.dirs.other, 'secret.txt'), w.dirs.memdir, '/etc/passwd', '../w002', '~/.claude/projects', '', '.', 'link/../x', w.dirs.W, '/']
  const commands = ['ls', 'claude', 'cat ../w002/secret.txt', 'git push', 'echo hi', `ls ${w.dirs.W}`, 'curl -X POST x', '"unterminated', '$(', 'rm -rf /', '\\', '', 'cc-rsi eval']
  const tools = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'Task', 'Agent', 'StructuredOutput', '', 'mcp__x__y']
  const payloads = []
  for (let i = 0; i < 500; i++) {
    const kind = rand(10)
    if (kind === 0) payloads.push(pick(['', '{', 'null', '[1,2]', '{"tool_name":null}', '"str"', '{"tool_input":"x"}']))
    else {
      const tool_name = pick(tools)
      const tool_input = { file_path: pick(paths), path: pick(paths), notebook_path: pick(paths), pattern: pick(['**/*', '../**', '*.py', paths[rand(paths.length)]]), command: pick(commands), content: 'x' }
      if (rand(3) === 0) delete tool_input.file_path
      payloads.push({ tool_name, tool_input, tool_use_id: `t${i}`, cwd: pick([w.dirs.cwd, '/', 'relative', undefined]) })
    }
  }
  const results = []
  const queue = payloads.map((p, i) => ({ p, i }))
  const workers = Array.from({ length: 16 }, async () => {
    while (queue.length > 0) {
      const { p, i } = queue.shift()
      const r = await w.run(i % 7 === 0 ? 'prompt' : 'tool', p)
      results.push(r)
    }
  })
  await Promise.all(workers)
  assert.equal(results.length, 500)
  for (const r of results) {
    assert.equal(r.code, 0)
    assert.ok(!r.stdout.includes('"allow"'))
    if (r.stdout.trim() !== '') JSON.parse(r.stdout)
  }
})

test('start-up time: a decision takes well under the hook budget', async () => {
  const w = await world()
  const times = []
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint()
    await w.tool('Read', { file_path: join(w.dirs.cwd, 'main.py') })
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  const median = times[3]
  assert.ok(median < 400, `median ${median.toFixed(1)} ms`)
})
