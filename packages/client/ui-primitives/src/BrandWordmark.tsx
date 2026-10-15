// AselDev Harness brand wordmark: the ‹A› bracket mark followed by the
// "AselDev Harness" name, replacing the upstream DeepSeek whale + "deepseek"
// + HARNESS badge art. The name rides currentColor and the theme's
// --dsw-font-family, so it works in both themes.

import type { IconProps } from './icons/props.ts'
import { BracketMark } from './FishLogo.tsx'

/** Brand name rendered by the wordmark. */
const BRAND_NAME = 'AselDev Harness'

/** Native width of the name text at a 24px height (17px / 600). */
const NAME_WIDTH = 150

/** Gap between the mark and the name at a 24px height. */
const GAP = 8

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; the name scales with it).
 * @param props.className - extra class for layout placement.
 * @returns the mark plus the name (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  const scale = size / 24
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: `${GAP * scale}px` }}
      aria-hidden="true"
    >
      <BracketMark size={size} />
      <svg
        width={NAME_WIDTH * scale}
        height={size}
        viewBox={`0 0 ${NAME_WIDTH} 24`}
        fill="none"
        overflow="visible"
      >
        <text
          x="0"
          y="17.5"
          fill="currentColor"
          style={{ fontFamily: 'var(--dsw-font-family)' }}
          fontSize="17"
          fontWeight="600"
          letterSpacing="-0.2"
        >
          {BRAND_NAME}
        </text>
      </svg>
    </span>
  )
}
