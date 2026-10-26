/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-market/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-market'

/** Cordis companion plugin name. */
export const name = 'client-ui-market-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns a browser Settings tab whose only
 * state is the tab's own React state, and the Host rows it calls are owned and
 * asserted by `@deepseek-ai/dsh-market`.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
