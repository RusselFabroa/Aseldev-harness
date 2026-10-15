/**
 * The artifacts window: a large in-page dialog with two faces. The library
 * lists every saved artifact as cards, filtered by type and title; the viewer
 * shows one artifact with its versions, a Preview / Code switch, a desktop /
 * phone width switch, and Copy, Download and Open-in-a-new-tab actions.
 * Pages render in an iframe loaded from the host's sandboxed `/view` route
 * (no allow-same-origin), so their scripts cannot reach this app; Markdown
 * renders in place with the chat's own Markdown renderer.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconCloseOutline16, IconCodeOutline16, IconCopyOutline16,
  IconDownloadOutline16, IconLinkOutline16, IconRightUpOutline16, IconSearchOutline16, MarkdownText, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { downloadUrl, viewUrl } from './api.ts'
import type { ArtifactDetail, ArtifactMeta, ArtifactsApi, ArtifactType } from './api.ts'
import { fill, relativeTime, typeKey, type Translate } from './format.ts'
import type { ArtifactsViewState } from './view-state.ts'
import css from './ArtifactsModal.module.css'

/** What a sandboxed iframe may do: run its own scripts, forms, dialogs, popups. Never same-origin. */
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'
const COPIED_MS = 1500

/** Props of {@link ArtifactsModal}. */
export interface ArtifactsModalProps {
  view: ArtifactsViewState
  api: ArtifactsApi
  onClose: () => void
  onOpenArtifact: (id: string, version?: number) => void
  onOpenLibrary: () => void
  /** Close the window and open the conversation that made the artifact. */
  onOpenSession: (sessionId: string) => void
  t: Translate
}

type Filter = 'all' | ArtifactType

const FILTERS: readonly Filter[] = ['all', 'html', 'markdown', 'svg', 'mermaid']

function filterLabel(filter: Filter, t: Translate): string {
  if (filter === 'all') return t('library.all')
  if (filter === 'mermaid') return t('library.diagrams')
  return t(typeKey(filter))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the artifacts window.
 * @param props - window state, Host calls and navigation callbacks.
 * @returns the dialog (rendered closed when the view says so).
 */
export function ArtifactsModal({ view, api, onClose, onOpenArtifact, onOpenLibrary, onOpenSession, t }: ArtifactsModalProps) {
  const title = view.id === null ? t('library.title') : t('section')
  return (
    <Modal open={view.open} onClose={onClose} title={title} closeLabel={t('close')} className={css.dialog as string} headless>
      {view.open && (view.id === null
        ? <Library api={api} changes={view.changes} onClose={onClose} onOpen={onOpenArtifact} t={t} />
        : (
          <Viewer
            key={view.id}
            api={api}
            id={view.id}
            requested={view.version}
            changes={view.changes}
            onClose={onClose}
            onBack={onOpenLibrary}
            onPickVersion={(version) => { onOpenArtifact(view.id ?? '', version) }}
            onOpenSession={onOpenSession}
            t={t}
          />
        ))}
    </Modal>
  )
}

/** Library face: type filter, title search, and the artifact grid. */
function Library({ api, changes, onClose, onOpen, t }: {
  api: ArtifactsApi
  changes: number
  onClose: () => void
  onOpen: (id: string) => void
  t: Translate
}) {
  const [items, setItems] = useState<readonly ArtifactMeta[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    api.list().then((result) => {
      if (!live) return
      setItems(result.artifacts)
      setFailure(null)
    }).catch((error: unknown) => {
      if (live) setFailure(messageOf(error))
    })
    return () => { live = false }
  }, [api, changes])

  const now = Date.now()
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (items ?? []).filter(item => (filter === 'all' || item.type === filter)
      && (needle === '' || item.title.toLowerCase().includes(needle)))
  }, [items, filter, query])

  return (
    <>
      <header className={css.header}>
        <div className={css.heading}>
          <IconCodeOutline16 className={css.headingIcon} size={20} />
          <h2 className={css.title}>{t('library.title')}</h2>
        </div>
        <label className={css.search}>
          <IconSearchOutline16 className={css.searchIcon} size={16} />
          <span className={css.visuallyHidden}>{t('library.searchLabel')}</span>
          <input
            className={css.searchInput}
            type="text"
            value={query}
            placeholder={t('library.search')}
            spellCheck={false}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </label>
        <button type="button" className={css.closeButton} aria-label={t('close')} onClick={onClose}>
          <IconCloseOutline16 size={18} />
        </button>
      </header>

      <div className={css.body}>
        <nav className={css.filters} aria-label={t('library.typeHeading')}>
          <span className={css.sideLabel}>{t('library.typeHeading')}</span>
          {FILTERS.map((option) => {
            const count = (items ?? []).filter(item => option === 'all' || item.type === option).length
            return (
              <button
                key={option}
                type="button"
                className={clsx(css.filter, filter === option && css.filterOn)}
                aria-pressed={filter === option}
                onClick={() => { setFilter(option) }}
              >
                <span className={css.filterLabel}>{filterLabel(option, t)}</span>
                <span className={css.filterCount}>{count}</span>
              </button>
            )
          })}
        </nav>

        <div className={css.gridArea}>
          {failure !== null && <p className={css.error}>{`${t('library.failed')} (${failure})`}</p>}
          {failure === null && items === null && <p className={css.status}>{t('library.loading')}</p>}
          {items !== null && items.length === 0 && (
            <div className={css.empty}>
              <IconCodeOutline16 size={36} className={css.emptyIcon} />
              <span className={css.emptyTitle}>{t('library.empty')}</span>
              <span className={css.emptyBody}>{t('library.emptyBody')}</span>
              <span className={css.emptyTry}>{t('library.emptyTry')}</span>
            </div>
          )}
          {items !== null && items.length > 0 && shown.length === 0 && <p className={css.status}>{t('library.noMatch')}</p>}
          {shown.length > 0 && (
            <div className={css.grid}>
              {shown.map(item => (
                <button key={item.id} type="button" className={css.tile} onClick={() => { onOpen(item.id) }}>
                  <span className={css.tileThumb} data-type={item.type} aria-hidden>
                    <IconCodeOutline16 size={28} />
                  </span>
                  <span className={css.tileText}>
                    <span className={css.tileTitle}>{item.title}</span>
                    <span className={css.tileMeta}>
                      <span className={css.badge}>{t(typeKey(item.type))}</span>
                      <span>{item.versions.length === 1 ? t('library.oneVersion') : fill(t('library.versions'), { n: item.versions.length })}</span>
                      <span aria-hidden>·</span>
                      <span>{relativeTime(item.updatedAt, now, t)}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className={css.footer}>{t('library.hint')}</footer>
    </>
  )
}

/** Viewer face: one artifact with versions, preview/code and actions. */
function Viewer({ api, id, requested, changes, onClose, onBack, onPickVersion, onOpenSession, t }: {
  api: ArtifactsApi
  id: string
  requested: number | null
  changes: number
  onClose: () => void
  onBack: () => void
  onPickVersion: (version: number) => void
  onOpenSession: (sessionId: string) => void
  t: Translate
}) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [phone, setPhone] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true
    setFailure(null)
    api.read(id, requested ?? undefined).then((loaded) => {
      if (live) setDetail(loaded)
    }).catch((error: unknown) => {
      if (live) setFailure(messageOf(error))
    })
    return () => { live = false }
  }, [api, id, requested, changes])

  useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current) }, [])

  const copy = (): void => {
    if (detail === null) return
    void writeClipboard(detail.content).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { setCopied(false) }, COPIED_MS)
    })
  }

  const meta = detail?.meta
  const version = detail?.version ?? 1
  const sessionId = meta?.sessionId ?? null

  return (
    <>
      <header className={css.header}>
        <button type="button" className={css.backButton} onClick={onBack}>
          <IconChevronLeftOutline14 size={14} />
          <span>{t('viewer.back')}</span>
        </button>
        <div className={css.heading}>
          <h2 className={css.title} title={meta?.title}>{meta?.title ?? t('viewer.loading')}</h2>
          {meta !== undefined && <span className={css.badge}>{t(typeKey(meta.type))}</span>}
        </div>

        {meta !== undefined && meta.versions.length > 1 && (
          <div className={css.segment} role="group" aria-label={t('viewer.versions')}>
            {meta.versions.map(v => (
              <button
                key={v.n}
                type="button"
                className={clsx(css.segmentButton, v.n === version && css.segmentOn)}
                aria-pressed={v.n === version}
                onClick={() => { onPickVersion(v.n) }}
              >
                {`v${String(v.n)}`}
              </button>
            ))}
          </div>
        )}

        <span className={css.spacer} />

        <div className={css.segment} role="group" aria-label={t('viewer.view')}>
          <button type="button" className={clsx(css.segmentButton, tab === 'preview' && css.segmentOn)} aria-pressed={tab === 'preview'} onClick={() => { setTab('preview') }}>{t('viewer.preview')}</button>
          <button type="button" className={clsx(css.segmentButton, tab === 'code' && css.segmentOn)} aria-pressed={tab === 'code'} onClick={() => { setTab('code') }}>{t('viewer.code')}</button>
        </div>

        {meta !== undefined && meta.type !== 'markdown' && tab === 'preview' && (
          <div className={css.segment} role="group" aria-label={t('viewer.width')}>
            <button type="button" className={clsx(css.segmentButton, css.segmentIcon, !phone && css.segmentOn)} aria-pressed={!phone} aria-label={t('viewer.desktop')} title={t('viewer.desktop')} onClick={() => { setPhone(false) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
            </button>
            <button type="button" className={clsx(css.segmentButton, css.segmentIcon, phone && css.segmentOn)} aria-pressed={phone} aria-label={t('viewer.phone')} title={t('viewer.phone')} onClick={() => { setPhone(true) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17h2" /></svg>
            </button>
          </div>
        )}

        <div className={css.actions}>
          {sessionId !== null && (
            <button
              type="button"
              className={css.actionButton}
              title={t('viewer.sessionHint')}
              onClick={() => { onOpenSession(sessionId) }}
            >
              <IconLinkOutline16 size={14} />
              <span>{t('viewer.session')}</span>
            </button>
          )}
          <button type="button" className={css.actionButton} disabled={detail === null} onClick={copy}>
            {copied ? <IconCheckOutline16 size={14} /> : <IconCopyOutline16 size={14} />}
            <span>{copied ? t('viewer.copied') : t('viewer.copy')}</span>
          </button>
          {detail !== null && (
            <>
              <a className={css.actionButton} href={downloadUrl(id, version)} download>
                <IconDownloadOutline16 size={14} />
                <span>{t('viewer.download')}</span>
              </a>
              <a className={css.iconAction} href={viewUrl(id, version)} target="_blank" rel="noopener noreferrer" aria-label={t('viewer.newTab')} title={t('viewer.newTab')}>
                <IconRightUpOutline16 size={16} />
              </a>
            </>
          )}
          <button type="button" className={css.closeButton} aria-label={t('close')} onClick={onClose}>
            <IconCloseOutline16 size={18} />
          </button>
        </div>
      </header>

      <div className={css.stage}>
        {failure !== null && <p className={css.error}>{failure}</p>}
        {failure === null && detail === null && <p className={css.status}>{t('viewer.loading')}</p>}
        {detail !== null && tab === 'code' && <pre className={css.code}>{detail.content}</pre>}
        {detail !== null && tab === 'preview' && detail.meta.type === 'markdown' && (
          <div className={css.markdownPage}><MarkdownText text={detail.content} /></div>
        )}
        {detail !== null && tab === 'preview' && detail.meta.type !== 'markdown' && (
          <iframe
            key={`${id}@${String(version)}`}
            className={clsx(css.frame, phone && css.framePhone)}
            src={viewUrl(id, version)}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            title={detail.meta.title}
          />
        )}
      </div>

      <footer className={css.viewerFooter}>
        <span className={css.lock}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          {t('viewer.sandbox')}
        </span>
        <span className={css.spacer} />
        {detail !== null && <span className={css.savedAt} title={detail.file}>{fill(t('viewer.saved'), { file: detail.file })}</span>}
      </footer>
    </>
  )
}
