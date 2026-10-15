import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as BrainInvariant from '@deepseek-ai/dsh-brain/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('brain invariants', () => {
  it('registers its companion with no runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(BrainInvariant)
    expect(ctx.invariants).toBeDefined()
    await ctx.fiber.dispose()
  })
})
