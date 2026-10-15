// AselDev Harness brand mark: an "A" between code brackets (‹A›). It replaces
// the upstream DeepSeek fish everywhere the fish was used (collapsed sidebar
// rail, new-chat hero), so the export keeps its name. The brackets ride the
// business accent token; the "A" rides currentColor, so it follows the
// surrounding ink in light and dark themes.

import type { IconProps } from './icons/props.ts'

/**
 * Render the AselDev bracket mark.
 * @param props.size - edge in px (default 24; the mark is square).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return <BracketMark size={size} className={className} />
}

/**
 * The square ‹A› mark shared by {@link FishLogo} and the wordmark.
 * @param props.size - edge in px.
 * @param props.className - extra class for layout placement.
 * @returns the mark svg.
 */
export function BracketMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 9l-6 7 6 7" strokeWidth="2.6" style={{ stroke: 'var(--dsw-alias-state-business-primary)' }} />
      <path d="M24 9l6 7-6 7" strokeWidth="2.6" style={{ stroke: 'var(--dsw-alias-state-business-primary)' }} />
      <path d="M11 24l5-15 5 15M13.2 18.5h5.6" stroke="currentColor" strokeWidth="2.6" />
    </svg>
  )
}
