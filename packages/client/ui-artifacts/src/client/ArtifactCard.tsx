/**
 * The `artifact` tool's card in the chat (keyed toolview). A pure function of
 * the logged call and result: while the call streams it shows the title and
 * how much has been written; once saved it shows the title, type and version
 * with Open and Download (a first version as a full card, later versions as a
 * compact "updated" row); a failed or stopped call shows why.
 */

import { useEffect } from 'react'
import clsx from 'clsx'
import { IconCodeOutline16, IconDownloadOutline16, IconLoadingOutline16, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { downloadUrl } from './api.ts'
import type { ArtifactType } from './api.ts'
import type { ArtifactCardProps } from './contract.ts'
import { fill, formatBytes, isArtifactType, typeKey, type Translate } from './format.ts'
import css from './ArtifactCard.module.css'

/** What the card shows, derived only from the call/result slice. */
type CardModel =
  | { state: 'running'; title: string | null; written: number }
  | { state: 'saved'; id: string; version: number; title: string; type: ArtifactType }
  | { state: 'error'; title: string | null; message: string }
  | { state: 'stopped'; title: string | null }

type Block = ArtifactCardProps['block']

/** Title from complete or still-streaming JSON arguments. */
function titleFrom(argsRaw: string): string | null {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const title = (parsed as Record<string, unknown>).title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
  } catch {
    // Streaming arguments are a JSON prefix; the regex below reads what has arrived.
  }
  const match = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsRaw)
  if (match === null) return null
  try {
    return JSON.parse(`"${match[1] ?? ''}"`) as string
  } catch {
    return match[1] ?? null
  }
}

/** First line of the result text, for the failure summary. */
function resultLine(block: Block): string {
  if (!('kind' in block)) return ''
  for (const item of block.content) {
    if (item.type === 'text' && item.text.trim() !== '') return item.text.trim().split('\n')[0] ?? ''
  }
  return block.error === undefined ? '' : `${block.error.name}: ${block.error.code}`
}

function cardModel(block: Block): CardModel {
  if (!('kind' in block)) return { state: 'running', title: titleFrom(block.argsRaw), written: block.argsRaw.length }
  const title = titleFrom(block.call?.argsRaw ?? '')
  if (block.error?.code === 'interrupted') return { state: 'stopped', title }
  if (block.isError) return { state: 'error', title, message: resultLine(block) }
  const meta = block.meta
  if (typeof meta === 'object' && meta !== null) {
    const m = meta as Record<string, unknown>
    if (typeof m.id === 'string' && typeof m.version === 'number' && typeof m.title === 'string' && isArtifactType(m.type)) {
      return { state: 'saved', id: m.id, version: m.version, title: m.title, type: m.type }
    }
  }
  return { state: 'error', title, message: resultLine(block) }
}

/** Small type-tinted tile standing in for a preview. */
function Thumb({ type, compact }: { type: ArtifactType; compact?: boolean }) {
  return (
    <span className={clsx(css.thumb, compact === true && css.thumbCompact)} data-type={type} aria-hidden>
      <IconCodeOutline16 size={compact === true ? 16 : 20} />
    </span>
  )
}

/**
 * Render one `artifact` tool call.
 * @param props - keyed toolview share plus the injected open/changed callbacks.
 * @returns the card.
 */
export function ArtifactCard({ block, t, openArtifact, changed }: ArtifactCardProps) {
  const tr = t as Translate
  const model = cardModel(block)
  const savedKey = model.state === 'saved' ? `${model.id}@${String(model.version)}` : null

  // A newly saved version refreshes the sidebar count and an open library.
  useEffect(() => {
    if (savedKey !== null) changed()
  }, [savedKey, changed])

  if (model.state === 'running') {
    return (
      <div className={css.card} role="status" data-state="running">
        <span className={clsx(css.thumb, css.thumbBusy)} aria-hidden><IconLoadingOutline16 className={css.spin} size={20} /></span>
        <span className={css.text}>
          <span className={css.title}>{model.title ?? tr('card.untitled')}</span>
          <span className={css.meta}>{fill(tr('card.writing'), { size: formatBytes(model.written) })}</span>
        </span>
        <button type="button" className={css.open} disabled>{tr('card.open')}</button>
      </div>
    )
  }

  if (model.state === 'error' || model.state === 'stopped') {
    const title = model.title ?? tr('card.untitled')
    return (
      <div className={clsx(css.card, css.failed)} role="alert" data-state={model.state}>
        <IconWarningOutline16 className={css.warn} size={18} />
        <span className={css.text}>
          <span className={css.title}>{model.state === 'error' ? fill(tr('card.failed'), { title }) : tr('card.stopped')}</span>
          {model.state === 'error' && model.message !== '' && <span className={css.meta}>{model.message}</span>}
        </span>
      </div>
    )
  }

  const open = (): void => { openArtifact(model.id, model.version) }

  if (model.version > 1) {
    return (
      <div className={clsx(css.card, css.compact)} role="group" aria-label={model.title} data-state="saved">
        <Thumb type={model.type} compact />
        <span className={css.compactText}>
          <span className={css.title}>{model.title}</span>
          {' '}
          <span className={css.meta}>{fill(tr('card.updated'), { n: model.version })}</span>
        </span>
        <button type="button" className={css.openSmall} onClick={open}>{tr('card.open')}</button>
      </div>
    )
  }

  return (
    <div className={css.card} role="group" aria-label={model.title} data-state="saved">
      <Thumb type={model.type} />
      <span className={css.text}>
        <span className={css.title}>{model.title}</span>
        <span className={css.meta}>
          <span className={css.badge}>{tr(typeKey(model.type))}</span>
          <span>{fill(tr('card.version'), { n: model.version })}</span>
        </span>
      </span>
      <button type="button" className={css.open} onClick={open}>{tr('card.open')}</button>
      <a className={css.iconButton} href={downloadUrl(model.id, model.version)} download aria-label={tr('card.download')} title={tr('card.download')}>
        <IconDownloadOutline16 size={16} />
      </a>
    </div>
  )
}
