/** The brain tools over a real temp vault; provider mount order stays irrelevant by design. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
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

let callCounter = 0

/**
 * Execute one tool call against the registry.
 * @param ctx - booted context.
 * @param name - tool name.
 * @param args - model-supplied arguments (registry validates them).
 * @returns the normalized execution outcome.
 */
function run(ctx: Context, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`brain-spec-${++callCounter}`),
    name,
    arguments: args as never,
  })
}

/** Result text of a text-only render. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot the registry, the tools, and a brain-local provider. With notes, the
 * provider mounts over a fresh temp vault AFTER the tools on purpose:
 * resolution happens per call, so mount order stays irrelevant.
 * @param withNotes - whether to create and configure a two-note temp vault.
 */
async function bootVault(withNotes: boolean): Promise<Context> {
  if (withNotes) {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-brain-'))
    await mkdir(join(root, 'Area'), { recursive: true })
    await writeFile(join(root, 'alpha.md'), '# Alpha\n\nthe brown fox jumps')
    await writeFile(join(root, 'Area', 'beta.md'), '# Beta\n\nnothing relevant here')
  }
  const ctx = new Context()
  context = ctx
  // The registry is a Service injecting `systemPrompt`; mount it first or the
  // `tools` service never materializes.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolBrain)
  await ctx.plugin(brainLocal, { ...(withNotes ? { path: root! } : {}) })
  return ctx
}

describe('brain_search', () => {
  it('returns bounded matches with paths, titles, and snippets', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_search', { query: 'BROWN fox' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      configured: true,
      matches: [{ path: 'alpha.md', title: 'alpha', snippet: '# Alpha the brown fox jumps' }],
    })
    expect(text(result)).toContain('- alpha.md — alpha: # Alpha the brown fox jumps')
  })

  it('reports an empty match list without inventing notes', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_search', { query: 'absent' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ configured: true, matches: [] })
    expect(text(result)).toBe('No matching notes.')
  })

  it('answers an unconfigured vault with a structured result, not an error', async () => {
    const ctx = await bootVault(false)
    const result = await run(ctx, 'brain_search', { query: 'anything' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ configured: false, matches: [] })
    expect(text(result)).toContain('No knowledge vault is configured')
  })

  it('rejects a blank query the schema cannot express', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_search', { query: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`query` must be a non-empty string')
  })

  it('fails loud when the composition mounts no brain provider at all', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolBrain)
    const result = await run(ctx, 'brain_search', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('knowledge-vault provider is not mounted')
  })
})

describe('brain_read', () => {
  it('returns the note body and renders it as the model-facing text', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_read', { path: 'Area/beta.md' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ path: 'Area/beta.md', title: 'beta', content: '# Beta\n\nnothing relevant here' })
    expect(text(result)).toBe('# Beta\n\nnothing relevant here')
  })

  it('surfaces a missing note as an error naming the path', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_read', { path: 'missing.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('note not found: missing.md')
  })

  it('keeps escaping paths rejected by the provider', async () => {
    const ctx = await bootVault(true)
    const result = await run(ctx, 'brain_read', { path: '../secret.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid note path')
  })

  it('maps an unconfigured vault to guidance instead of the bare provider error', async () => {
    const ctx = await bootVault(false)
    const result = await run(ctx, 'brain_read', { path: 'any.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No knowledge vault is configured')
  })

  it('fails loud when the composition mounts no brain provider at all', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolBrain)
    const result = await run(ctx, 'brain_read', { path: 'x.md' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('knowledge-vault provider is not mounted')
  })
})
