// Unit tests for lib/guard/bash.mjs and lib/guard/paths.mjs (SPEC §10.6), in process. Port of the dsh-rsi
// test/isolation.test.ts physicalPath/privatePathGuard cases plus the cc-rsi Bash heuristics.

import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandWords, coversHiddenReason, hiddenReason, MUTATION_BASH_DENY, scanBash } from '../../lib/guard/bash.mjs'
import { canonicalRoot, isFileTool, isUnder, physicalPath, searchCoversHidden, toolPathArgs } from '../../lib/guard/paths.mjs'
import { tmpDir } from '../_helpers/tmp.mjs'

test('commandWords: separators, prefixes and assignments', () => {
  const words = c => commandWords(c).map(w => w.word)
  assert.deepEqual(words('a; b && c || d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.deepEqual(words('(cd x && make) && echo $(date) `whoami`'), ['cd', 'make', 'echo', 'date', 'whoami'])
  assert.deepEqual(words('FOO=1 BAR="a b" env -u X sudo -u root exec nohup time command nice -n 5 timeout 10 claude -p'), ['claude'])
  assert.deepEqual(commandWords('timeout -s KILL 5s ls -la')[0], { word: 'ls', args: ['-la'] })
  assert.deepEqual(commandWords("echo 'a;b' \"c && d\"")[0], { word: 'echo', args: ['a;b', 'c && d'] })
  assert.deepEqual(words('if claude; then x; fi'), ['claude', 'x'])
  assert.deepEqual(words('ls # claude here is a comment\nwhoami'), ['ls', 'whoami'])
  assert.deepEqual(words('echo "$(claude -p x)"'), ['echo', 'claude'])
  assert.deepEqual(words(''), [])
})

test('scanBash: recursion closure', () => {
  const deny = c => scanBash(c, {})
  for (const c of ['claude', '/opt/claude-code/bin/claude -p x', 'cc-rsi status', 'node ~/plugin/bin/cc-rsi', 'nodejs /x/claude-code/cli.js', 'npx -y @anthropic-ai/claude-code',
    'yarn dlx @anthropic-ai/claude-code', 'sh -c "cc-rsi explore start"', 'bash -lc claude', 'xargs claude < list', 'eval "claude -p hi"']) {
    assert.match(deny(c) ?? '', /recursion is refused/, c)
  }
  for (const c of ['echo claude', 'node script.js', 'npx prettier .', 'cat claude-notes.md']) assert.equal(deny(c), null, c)
  assert.equal(scanBash('claude -p hi', { recursionGuard: false }), null, 'the main-session guard disables the recursion rule')
})

test('scanBash: home expansion, masking at path boundaries, tokens', () => {
  const opts = { hidden: ['/h/.cc-rsi'], allowedPaths: ['/h/.cc-rsi/projects/k/views/s/memory', '/h/.cc-rsi/bin'], home: '/h/.cc-rsi', userHome: '/h', recursionGuard: false }
  assert.equal(scanBash('ls ~/.cc-rsi/projects/k/views/s/memory', opts), null)
  assert.equal(scanBash('cat $HOME/.cc-rsi/bin/cc-rsi', opts), null)
  assert.equal(scanBash('cat ${CC_RSI_HOME}/projects/k/store/journal.jsonl', opts), hiddenReason('/h/.cc-rsi'))
  assert.equal(scanBash('cat ~/.cc-rsi/projects/k/views/s/memoryX/f', opts), hiddenReason('/h/.cc-rsi'), 'masking stops at path boundaries')
  assert.equal(scanBash('ls ~/.cc-rsi', opts), hiddenReason('/h/.cc-rsi'))
  assert.equal(scanBash('ls /h/.cc-rsi-other', opts), null, 'a sibling name is not the hidden root')
  assert.equal(scanBash('cat x', { hiddenTokens: ['actor-private'] }), null)
  assert.equal(scanBash('cat ../../actor-private/w1/memory/x', { hiddenTokens: ['actor-private'] }), hiddenReason('actor-private'))
  // an allowed path that is a prefix of a hidden sibling does not mask it
  const sib = { hidden: ['/w/projects/t0011'], allowedPaths: ['/w/projects/t001'] }
  assert.equal(scanBash('cat /w/projects/t0011/secret', sib), hiddenReason('/w/projects/t0011'))
  assert.equal(scanBash('cat /w/projects/t001/ok', sib), null)
})

test('scanBash: relative traversal and cd are resolved against the cwd', async () => {
  const base = realpathSync(await tmpDir())
  const cwd = join(base, 'projects', 'a')
  const other = join(base, 'projects', 'b')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(other, { recursive: true })
  symlinkSync(other, join(cwd, 'sneaky'))
  const opts = { hidden: [other], allowedPaths: [cwd], cwd }
  assert.equal(scanBash('cat ../b/x', opts), hiddenReason(other))
  assert.equal(scanBash('cd .. && ls b', opts), hiddenReason(other))
  assert.equal(scanBash('cd ..; cd b; ls', opts), hiddenReason(other))
  assert.equal(scanBash('ls sneaky/', opts), hiddenReason(other), 'a symlink to a hidden root is resolved physically')
  assert.equal(scanBash('git diff --stat HEAD~1 -- src/', opts), null)
  assert.equal(scanBash('ls ..', opts), null, 'the parent itself is not hidden')
  assert.equal(scanBash('python - <<EOF\nprint(1)\nEOF', opts), null)
})

/** A user home with cc-rsi state, a project and a symlink from the project to the home (security-6 probes). */
async function homeLayout() {
  const base = realpathSync(await tmpDir())
  const userHome = join(base, 'uh')
  const home = join(userHome, '.cc-rsi')
  const proj = join(userHome, 'proj')
  mkdirSync(join(home, 'projects', 'k', 'sessions', 's1'), { recursive: true })
  mkdirSync(join(proj, 'src'), { recursive: true })
  symlinkSync(userHome, join(proj, 'uhlink'))
  const opts = (cwd = proj, extra = {}) => ({ hidden: [home], allowedPaths: [], home, userHome, recursionGuard: false, cwd, ...extra })
  return { base, userHome, home, proj, opts }
}

test('scanBash: globs and brace lists are expanded against hidden roots (security-6)', async () => {
  const { userHome, home, proj, opts } = await homeLayout()
  for (const command of [
    'cat ~/.cc-r*/projects/*/sessions/*/task.json',
    'cat ~/.cc-rs?/projects/k/sessions/s1/task.json',
    'sed -i s/FAIL/PASS/ ~/.cc-r*/projects/*/sessions/*/task.json',
    'cp /tmp/x ~/.cc-rs[i]/config.json',
    'cat ~/.cc-{rsi,other}/config.json',
    'cat ~/.c*/projects/k/x',
    'ls ~/.*',
    'echo x > ~/.cc-r*/config.json',
    'cat uhlink/.cc-*/projects/k/x',
    `cat ${userHome}/.cc-rs[!x]/x`,
    'shopt -s dotglob; cat ~/*/projects/k/x',
    'bash -c "cat ~/.cc-r*/x"',
  ]) {
    assert.equal(scanBash(command, opts()), hiddenReason(home), command)
  }
  // Plain spellings that cannot reach the hidden root stay allowed (bash: `*` and `**` skip dot names).
  for (const command of ['ls *.py', 'cat ./src/*.js', 'ls ~/.*rc', 'cat ~/.bashrc', 'cat ~/*.txt', 'cat ~/**/x.txt', 'du -sh ~/*', 'mkdir -p {a,b}/c',
    'echo {1..100}', 'ls /tmp/*.log', `cat ${userHome}/.cc-rs[^i]/x`, 'for f in src/*; do echo $f; done']) {
    assert.equal(scanBash(command, opts()), null, command)
  }
  // An allowed path inside the hidden root stays usable through globs.
  const view = join(home, 'projects', 'k', 'views')
  assert.equal(scanBash('ls ~/.cc-rsi/projects/k/views/*', opts(proj, { allowedPaths: [view] })), null)
  // A glob whose expansions are an ancestor of a hidden root matters only to commands that walk trees.
  assert.equal(scanBash(`ls -d ${proj.slice(0, -1)}*`, opts()), null)
  assert.equal(scanBash(`du -sh ${userHome}*`, opts()), hiddenReason(home))
})

test('scanBash: commands that walk directory trees may not start above a hidden root (security-6)', async () => {
  const { userHome, home, proj, opts } = await homeLayout()
  const denied = [
    [proj, 'grep -rn VERDICT ~'],
    [proj, `grep -rn VERDICT ${userHome}`],
    [proj, 'find ~ -name task.json'],
    [proj, 'find -L ~ -name task.json'],
    [proj, 'cd .. && grep -r VERDICT .'],
    [proj, 'ls -R ~'],
    [proj, 'grep -r --include=*.json VERDICT ..'],
    [proj, 'grep -d recurse VERDICT ~'],
    [proj, 'rsync -a ~/ /tmp/backup'],
    [proj, 'cp -r ~ /tmp/copy'],
    [proj, 'mv ~ /tmp/elsewhere'],
    [proj, 'rm -rf ..'],
    [proj, 'chmod -R 777 ~'],
    [proj, 'zip -r /tmp/z.zip ..'],
    [proj, 'tar czf /tmp/x.tgz -C ~ .'],
    [proj, 'diff -r ~ /tmp/y'],
    [proj, 'du -sh ~'],
    [proj, 'tree ~'],
    [proj, 'fd task ~'],
    [proj, 'find / -name x 2>/dev/null'],
    [proj, 'grep -r x $PWD/..'],
    [proj, 'cd ~ && rg VERDICT'],
    [proj, 'bash -c "grep -r x ~"'],
    [proj, 'eval "find ~ -name x"'],
    [proj, 'grep -r x uhlink'],
    [proj, `ls -R ${userHome.slice(0, -1)}*`],
    // Started in the user home: the cwd itself is walked.
    [userHome, 'grep -r foo .'],
    [userHome, 'grep -r -e VERDICT'],
    [userHome, 'grep -rn VERDICT 2>/dev/null'],
    [userHome, 'rg VERDICT'],
    [userHome, 'find -name task.json'],
    [userHome, 'du -sh 2>/dev/null'],
    [userHome, 'ls -R'],
  ]
  for (const [cwd, command] of denied) assert.equal(scanBash(command, opts(cwd)), hiddenReason(home), `${command} (cwd ${cwd === proj ? 'project' : 'home'})`)
  const allowed = ['grep -r foo src', 'grep -rn "TODO" . --include=*.py', 'find . -name x', 'find src -name "*.py" -exec grep -l x {} +', 'ls -la ..', 'ls ~', 'cp -r src ~',
    'cp ~/.bashrc .', 'grep foo ~/notes.txt', 'rm -rf build', 'rsync -av src/ /tmp/dst/', 'tar czf /tmp/p.tgz -C ~ proj', 'rg x src 2>&1 | head', 'git grep -n x',
    'du -sh .', 'ls -R src', 'find . -type f -name "*.log" -delete', 'grep -r . src', 'rm -rf ./* ./.[!.]* 2>/dev/null; true']
  for (const command of allowed) assert.equal(scanBash(command, opts()), null, command)
  // The caller chooses the reason (the role guard uses the Grep/Glob search-root reason).
  assert.equal(scanBash('grep -rn VERDICT ~', opts(proj, { coversReason: path => coversHiddenReason(path) })), coversHiddenReason(userHome))
  assert.match(coversHiddenReason('/x'), /^\/x contains a harness-private path hidden from this role; narrow the search path/)
  // A store root without a leading dot is reached by `*` too.
  const store = join(userHome, 'store')
  mkdirSync(store)
  assert.equal(scanBash('du -sh ~/*', opts(proj, { hidden: [store] })), hiddenReason(store))
  assert.equal(scanBash('ls ~/*', opts(proj, { hidden: [store] })), hiddenReason(store), 'ls of a dir lists the hidden root itself')
  assert.equal(scanBash('ls ~/p*', opts(proj, { hidden: [store] })), null)
})

test('commandWords: redirections and descriptor numbers are not command words', () => {
  assert.deepEqual(commandWords('>out claude -p x')[0], { word: 'claude', args: ['out', '-p', 'x'] })
  assert.deepEqual(commandWords('make 2>&1 | tee log').map(w => w.word), ['make', 'tee'])
  assert.deepEqual(commandWords('cat <<EOF\nx\nEOF')[0], { word: 'cat', args: ['EOF'] })
  assert.deepEqual(commandWords('ls &>> log x')[0], { word: 'ls', args: ['log', 'x'] })
})

test('scanBash: bashDeny patterns, invalid patterns fail closed', () => {
  assert.match(scanBash('git push', { bashDeny: MUTATION_BASH_DENY }), /cannot be rolled back/)
  assert.equal(scanBash('git pull', { bashDeny: MUTATION_BASH_DENY }), null)
  assert.match(scanBash('anything', { bashDeny: [{ source: '(', flags: '' }] }), /invalid bashDeny/)
  assert.match(scanBash('drop table', { bashDeny: [/drop\s+table/i] }), /refused by the role policy/)
  assert.match(scanBash(null, {}), /malformed/)
  for (const rule of MUTATION_BASH_DENY) assert.doesNotThrow(() => new RegExp(rule.source, rule.flags))
})

test('physicalPath: `..` after a symlink is the parent of its target (dsh isolation.ts)', async () => {
  const base = realpathSync(await tmpDir())
  mkdirSync(join(base, 'real', 'deep'), { recursive: true })
  mkdirSync(join(base, 'cwd'))
  symlinkSync(join(base, 'real', 'deep'), join(base, 'cwd', 'link'))
  assert.equal(physicalPath(`${base}/cwd/link/../x`, '/'), join(base, 'real', 'x'))
  assert.equal(physicalPath('link/../x', join(base, 'cwd')), join(base, 'real', 'x'))
  assert.equal(physicalPath('missing/../y', join(base, 'cwd')), join(base, 'cwd', 'y'))
  assert.equal(physicalPath('', join(base, 'cwd')), join(base, 'cwd'))
  assert.equal(physicalPath('/no/such/dir/file', '/'), '/no/such/dir/file')
  assert.equal(canonicalRoot(join(base, 'cwd', 'link')), join(base, 'real', 'deep'))
})

test('isUnder', () => {
  assert.ok(isUnder('/a/b', '/a'))
  assert.ok(isUnder('/a', '/a'))
  assert.ok(isUnder('/a/..b', '/a'))
  assert.ok(!isUnder('/ab', '/a'))
  assert.ok(!isUnder('/a/../c', '/a'))
  assert.ok(isUnder('/anything', '/'))
  assert.ok(!isUnder('', '/a'))
})

test('toolPathArgs and searchCoversHidden', async () => {
  const cwd = realpathSync(await tmpDir())
  writeFileSync(join(cwd, 'f.txt'), 'x')
  assert.deepEqual(toolPathArgs('Read', { file_path: 'f.txt' }, cwd), { paths: [join(cwd, 'f.txt')], search: false, write: false, invalid: null })
  assert.deepEqual(toolPathArgs('Write', { file_path: '/x/y' }, cwd).write, true)
  assert.deepEqual(toolPathArgs('NotebookEdit', { notebook_path: '/x/n.ipynb' }, cwd).paths, ['/x/n.ipynb'])
  assert.deepEqual(toolPathArgs('Grep', { pattern: 'x' }, cwd), { paths: [cwd], search: true, write: false, invalid: null })
  assert.deepEqual(toolPathArgs('Glob', { pattern: '/etc/**/*.conf' }, cwd).paths, [cwd, '/etc'])
  assert.deepEqual(toolPathArgs('Glob', { pattern: '../../**' }, cwd).paths.slice(1), [join(cwd, '..', '..')])
  assert.deepEqual(toolPathArgs('Read', { file_path: '~/x' }, cwd, { userHome: '/home/u' }).paths, ['/home/u/x'])
  assert.match(toolPathArgs('Edit', {}, cwd).invalid, /without a file_path/)
  assert.deepEqual(toolPathArgs('Bash', { command: 'ls' }, cwd), { paths: [], search: false, write: false, invalid: null })
  assert.ok(isFileTool('Glob') && isFileTool('MultiEdit') && !isFileTool('Bash'))
  assert.equal(searchCoversHidden('/w', ['/x', '/w/a/hidden']), '/w/a/hidden')
  assert.equal(searchCoversHidden('/w/a/hidden/sub', ['/w/a/hidden']), null)
  assert.equal(searchCoversHidden('/w', []), null)
})
