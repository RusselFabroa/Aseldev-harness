import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as BrainLocalInvariant from '@deepseek-ai/dsh-brain-local/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('brain-local invariants', () => {
  it('registers its companion with no runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(BrainLocalInvariant)
    expect(ctx.invariants).toBeDefined()
    await ctx.fiber.dispose()
  })
})
