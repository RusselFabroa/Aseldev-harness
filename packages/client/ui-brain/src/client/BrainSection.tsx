/**
 * The Asel's Brain entry filling the sidebar shell's `sidebar.brain` hole: one
 * button (a labelled row when the sidebar is wide, an icon with a tooltip on
 * the collapsed rail) that opens the brain window. The vault tree, search and
 * reader live in {@link BrainModal}. The vault baseline arrives through the
 * global useBrain hook; read/search/refresh are the injected Host callbacks,
 * handed to the window unchanged.
 */

import { useCallback, useState } from 'react'
import clsx from 'clsx'
import { IconThinkOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrainSectionProps } from './contract/slots.ts'
import { BrainModal } from './BrainModal.tsx'
import css from './BrainSection.module.css'

/**
 * Render the sidebar's brain button and the window it opens.
 * @param props - shell owner share, the vault baseline hook, and Host actions.
 * @returns the button plus the (closed or open) window.
 */
export function BrainSection({ wide, useBrain, search, read, refresh, t }: BrainSectionProps) {
  const list = useBrain(s => s)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])

  const button = (
    <button
      type="button"
      className={clsx(css.button, wide ? css.wide : css.rail)}
      aria-label={t('open.aria')}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { setOpen(true) }}
    >
      <IconThinkOutline16 className={css.icon} size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{t('section')}</span>}
    </button>
  )

  return (
    <div className={clsx(css.section, !wide && css.sectionRail)}>
      {wide ? button : <Tooltip label={t('section')} delayMs={500}>{button}</Tooltip>}
      <BrainModal
        open={open}
        onClose={close}
        list={list}
        search={search}
        read={read}
        refresh={refresh}
        t={t}
      />
    </div>
  )
}
