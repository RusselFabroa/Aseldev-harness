// Real composition proof: the tool and its provider boot from a cordis.yml
// through the Loader, and both registered schemas plus one end-to-end read
// work against a temp vault — the assembled path a deployment actually takes.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as brainLocal from '@deepseek-ai/dsh-brain-local'
import * as ToolBrain from '@deepseek-ai/dsh-tool-brain'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the brain-local vault row (pointed at a temp
 * vault) and the tool row through the real Loader.
 * @returns the booted context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-brain-loader-'))
  const vault = join(root, 'vault')
  await mkdir(join(vault, 'notes'), { recursive: true })
  await writeFile(join(vault, 'notes', 'idea.md'), '# Idea\n\na captured thought')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-brain-local'",
    '  config:',
    `    path: ${JSON.stringify(vault)}`,
    "- name: '@deepseek-ai/dsh-tool-brain'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-brain-local', brainLocal],
    ['@deepseek-ai/dsh-tool-brain', ToolBrain],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-brain real Loader composition through cordis.yml', () => {
  it('registers both tools and reads a note end to end over the configured vault', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('brain_search')
    expect(names).toContain('brain_read')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-read'),
      name: 'brain_read',
      arguments: { path: 'notes/idea.md' },
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ path: 'notes/idea.md', title: 'idea', content: '# Idea\n\na captured thought' })
  }, 30_000)
})
