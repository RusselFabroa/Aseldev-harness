import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolBrainInvariant from '@deepseek-ai/dsh-tool-brain/invariant'

describe('tool-brain invariants', () => {
  it('registers an explained-empty companion without failures', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ToolBrainInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
