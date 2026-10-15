/**
 * Model-facing consumers of the brain seam (`ctx.brain`): `brain_search`
 * runs the provider's bounded full-text search and `brain_read` returns one
 * note's Markdown body. Both are read-only. An unconfigured vault is a
 * structured `configured: false` result rather than an error, so a deployment
 * that never set a path degrades to an honest answer instead of tool noise; a
 * composition without any brain provider fails loud instead.
 *
 * @module @deepseek-ai/dsh-tool-brain
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrainError } from '@deepseek-ai/dsh-brain'
import type { BrainSearchMatch, BrainService } from '@deepseek-ai/dsh-brain'

export const name = 'tool-brain'

/** The brain provider resolves at execution time, so the row needs only the registry. */
export const inject = ['tools']

/** Model-facing text returned while the deployment has no vault configured. */
const UNCONFIGURED =
  'No knowledge vault is configured on this deployment. Tell the user they can '
  + 'set its folder under Settings → Plugins → Brain.'

/**
 * Resolve the mounted brain provider.
 * @param ctx - registrant context.
 * @returns the provider, or undefined when the composition mounts none.
 */
function brain(ctx: Context): BrainService | undefined {
  // Optional service: strict reads keep this independent of mount order and realm.
  return ctx.get('brain') as BrainService | undefined
}

/** Canonical `brain_search` output value. */
interface BrainSearchOutput {
  configured: boolean
  matches: readonly BrainSearchMatch[]
}

/** Canonical `brain_read` output value. */
interface BrainReadOutput {
  path: string
  title: string
  content: string
}

/**
 * Register the two read-only vault tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'brain_search',
    description:
      'Search the user\'s personal knowledge vault of Markdown notes for a keyword. '
      + 'Case-insensitive full-text match over note titles and bodies with bounded results, '
      + 'each carrying the vault-relative path, the title, and a snippet. Pair with '
      + 'brain_read to load a full note.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The keyword or phrase to search for.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configured: { type: 'boolean', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: BrainSearchOutput) => [{
        type: 'text',
        text: !value.configured
          ? UNCONFIGURED
          : value.matches.length === 0
            ? 'No matching notes.'
            : `${value.matches.length} matching note(s):\n`
              + value.matches.map(match => `- ${match.path} — ${match.title}: ${match.snippet}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const vault = brain(ctx)
      if (vault === undefined) throw new Error('the knowledge-vault provider is not mounted')
      const query = args.query.trim()
      if (query === '') throw new Error('invalid brain_search call: `query` must be a non-empty string')
      const configured = vault.status().configured
      const matches = configured ? await vault.search(query, exec.signal) : []
      return { configured, matches }
    },
    presentCall: args => ({ card: 'generic', title: 'Search knowledge vault', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'brain_read',
    description:
      'Read one note from the user\'s personal knowledge vault by its vault-relative path '
      + '(with the .md extension), as returned by brain_search. Returns the note\'s Markdown body.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Vault-relative note path including the .md extension, e.g. from a brain_search match.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value: BrainReadOutput) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const vault = brain(ctx)
      if (vault === undefined) throw new Error('the knowledge-vault provider is not mounted')
      try {
        const content = await vault.read(args.path, exec.signal)
        const lastSlash = args.path.lastIndexOf('/')
        const title = args.path.slice(lastSlash + 1).replace(/\.md$/i, '')
        return { path: args.path, title, content }
      } catch (error: unknown) {
        if (error instanceof BrainError && error.code === 'BRAIN_NOT_CONFIGURED') {
          throw new Error(UNCONFIGURED)
        }
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read note', kind: 'read', rawInput: args.path }),
  }))
}
