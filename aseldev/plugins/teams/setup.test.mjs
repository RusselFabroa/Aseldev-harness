/** Exercise the user's real setup command in an isolated Harness home. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, unlinkSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(root, 'aseldev', 'setup-profile.ps1')

test('package linking refuses real directories without touching their content', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-team-real-directory-'))
  const link = join(home, 'profiles', 'node_modules', '@aseldev', 'dsh-teams')
  try {
    mkdirSync(link, { recursive: true })
    writeFileSync(join(link, 'keep.txt'), 'untouched')
    const result = spawnSync(process.execPath, [join(root, 'aseldev', 'plugins', 'teams', 'link-profile.mjs'), home], { stdio: 'ignore' })
    if (result.error) throw result.error
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(join(link, 'keep.txt'), 'utf8'), 'untouched')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('profile setup preserves user patches, is idempotent, and replaces only stale package links', { skip: process.platform !== 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh team setup '))
  const profile = join(home, 'profiles', 'web')
  const link = join(home, 'profiles', 'node_modules', '@aseldev', 'dsh-teams')
  try {
    mkdirSync(profile, { recursive: true })
    const custom = '# user-owned configuration\n- id: untouched-user-entry\n  disabled: true\n'
    // The setup script must leave configuration outside its markers unchanged.
    writeFileSync(join(profile, 'cordis.patch.yml'), custom)
    mkdirSync(join(home, 'profiles', 'node_modules', '@aseldev'), { recursive: true })
    const stale = join(home, 'stale-target')
    mkdirSync(stale)
    writeFileSync(join(stale, 'keep.txt'), 'do not delete the target')
    symlinkSync(stale, link, 'junction')
    for (let n = 0; n < 2; n++) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DshHome', home], { cwd: root, stdio: 'inherit' })
      if (result.error) throw result.error
      assert.equal(result.status, 0, 'real setup command must succeed')
    }
    const content = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(content.startsWith(custom.trimEnd()))
    assert.equal((content.match(/id: aseldev-teams\b/g) ?? []).length, 1)
    assert.equal(readFileSync(join(stale, 'keep.txt'), 'utf8'), 'do not delete the target')
    assert.ok(lstatSync(link).isSymbolicLink())
    const require = createRequire(join(profile, 'probe.cjs'))
    assert.equal(resolve(require.resolve('@aseldev/dsh-teams/package.json')), join(root, 'aseldev', 'plugins', 'teams', 'package.json'))
    assert.match(require.resolve('@aseldev/dsh-teams'), /lib[\\/]host\.js$/)
  } finally {
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link)
    rmSync(home, { recursive: true, force: true })
  }
})
