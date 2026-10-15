/**
 * The Artifacts entry in the sidebar launcher list (under Asel's Brain): a
 * labelled button with the artifact count when the sidebar is wide, an icon
 * with a tooltip on the collapsed rail. It also hosts the artifacts window,
 * which the chat cards open through the shared view state.
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconCodeOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArtifactsSectionProps } from './contract.ts'
import type { Translate } from './format.ts'
import { ArtifactsModal } from './ArtifactsModal.tsx'
import css from './ArtifactsSection.module.css'

/**
 * Render the sidebar button and the (closed or open) artifacts window.
 * @param props - sidebar owner share, the view-state hook, Host calls and actions.
 * @returns the section.
 */
export function ArtifactsSection({ wide, useArtifactsView, api, openLibrary, openArtifact, close, openSession, t }: ArtifactsSectionProps) {
  const view = useArtifactsView(s => s)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    api.list().then((result) => {
      if (live) setCount(result.artifacts.length)
    }).catch(() => {
      if (live) setCount(null)
    })
    return () => { live = false }
  }, [api, view.changes])

  const label = t('section')
  const button = (
    <button
      type="button"
      className={clsx(css.button, wide ? css.wide : css.rail)}
      aria-label={t('open.aria')}
      aria-haspopup="dialog"
      aria-expanded={view.open}
      onClick={openLibrary}
    >
      <IconCodeOutline16 className={css.icon} size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{label}</span>}
      {wide && count !== null && count > 0 && <span className={css.count}>{count}</span>}
    </button>
  )

  return (
    <div className={clsx(css.section, !wide && css.sectionRail)}>
      {wide ? button : <Tooltip label={label} delayMs={500}>{button}</Tooltip>}
      <ArtifactsModal
        view={view}
        api={api}
        onClose={close}
        onOpenArtifact={openArtifact}
        onOpenLibrary={openLibrary}
        onOpenSession={openSession}
        t={t as Translate}
      />
    </div>
  )
}
