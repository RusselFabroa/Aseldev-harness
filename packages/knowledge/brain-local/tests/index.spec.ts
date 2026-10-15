/** The `brain-local` provider over a real temp vault, layered over its settings namespace. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-brain'
import * as brainLocal from '@deepseek-ai/dsh-brain-local'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(vault: string): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(brainLocal, { path: vault }).await()
  return { ctx }
}

describe('brain-local provider', () => {
  const roots: string[] = []

  async function vault(entries: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-brain-'))
    roots.push(root)
    for (const [rel, content] of Object.entries(entries)) {
      await mkdir(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true })
      await writeFile(join(root, rel), content)
    }
    return root
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('lists a folder/note tree and reads a note', async () => {
    const root = await vault({
      'index.md': '# Index\n\nwelcome',
      'Area/alpha.md': '# Alpha\n\nalpha body',
    })
    const { ctx } = await boot(root)

    expect(ctx.brain.status()).toMatchObject({ configured: true })
    const tree = await ctx.brain.list()
    expect(tree).toEqual([
      {
        kind: 'folder', name: 'Area', path: 'Area',
        children: [{ kind: 'note', name: 'alpha', path: 'Area/alpha.md' }],
      },
      { kind: 'note', name: 'index', path: 'index.md' },
    ])

    expect(await ctx.brain.read('Area/alpha.md')).toBe('# Alpha\n\nalpha body')
    await ctx.fiber.dispose()
  })

  it('searches note bodies case-insensitively with a snippet', async () => {
    const root = await vault({ 'note.md': '# Note\n\nThe quick brown fox jumps.' })
    const { ctx } = await boot(root)

    const matches = await ctx.brain.search('BROWN fox')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ path: 'note.md', title: 'note' })
    expect(matches[0]?.snippet).toContain('brown fox')

    expect(await ctx.brain.search('absent')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects absolute and escaping read paths', async () => {
    const root = await vault({ 'note.md': 'body' })
    const { ctx } = await boot(root)

    await expect(ctx.brain.read('/etc/passwd')).rejects.toMatchObject({ code: 'BRAIN_INVALID_PATH' })
    await expect(ctx.brain.read('../secret.md')).rejects.toMatchObject({ code: 'BRAIN_INVALID_PATH' })
    await expect(ctx.brain.read('missing.md')).rejects.toMatchObject({ code: 'BRAIN_NOT_FOUND' })
    await ctx.fiber.dispose()
  })

  it('serves an empty tree when unconfigured', async () => {
    const { ctx } = await boot('')
    expect(ctx.brain.status()).toEqual({ configured: false })
    expect(await ctx.brain.list()).toEqual([])
    await expect(ctx.brain.read('note.md')).rejects.toMatchObject({ code: 'BRAIN_NOT_CONFIGURED' })
    await ctx.fiber.dispose()
  })
})
