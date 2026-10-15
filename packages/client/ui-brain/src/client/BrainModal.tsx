/**
 * The Asel's Brain window: a large in-page dialog opened from the sidebar
 * button. One left sidebar holds the vault tree (folders expand in place to
 * show their notes) or, while a query is typed, the full-text search results;
 * the right side is the reader, rendering the selected note's Markdown.
 * Everything arrives from BrainSection: the vault baseline it reads through
 * useBrain and the Host read/search callbacks it was injected with. The
 * component stays mounted while the dialog is closed, so the open folders,
 * the selected note and the query are kept between openings.
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseFill14, IconCloseOutline16,
  IconCopyOutline16, IconFolderClose16, IconFolderOpen16, IconSearchOutline16, IconThinkOutline16,
  MarkdownText, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrainListState, BrainSearchMatch, BrainTreeNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { BrainSectionProps } from './contract/slots.ts'
import css from './BrainModal.module.css'

/** Pause between the latest keystroke and a Host search request. */
const SEARCH_DEBOUNCE_MS = 250

/** How long a copy button shows its confirmation. */
const COPIED_MS = 1500

/** Props of {@link BrainModal}. */
export interface BrainModalProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close the dialog (close button, Escape, or a mask click). */
  onClose: () => void
  /** The vault baseline. */
  list: BrainListState
  /** Full-text search across the vault. */
  search: BrainSectionProps['search']
  /** Read one note by vault-relative path. */
  read: BrainSectionProps['read']
  /** Re-pull the vault baseline after a failed load. */
  refresh: () => void
  /** Section copy. */
  t: BrainSectionProps['t']
}

/** A note shown in the reader. */
interface OpenNote {
  path: string
  title: string
  content: string
}

/** Small document glyph for note rows. */
function NoteGlyph() {
  return (
    <svg className={css.glyph} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

/** Recursive vault tree; folders expand in place, notes open in the reader. */
function TreeRows({ nodes, depth, expanded, selected, onToggle, onOpen }: {
  nodes: readonly BrainTreeNode[]
  depth: number
  expanded: ReadonlySet<string>
  selected: string | null
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        const indent = { paddingLeft: `${10 + depth * 16}px` }
        if (node.kind === 'folder') {
          const isOpen = expanded.has(node.path)
          return (
            <div key={node.path}>
              <button
                type="button"
                className={clsx(css.row, css.folderRow)}
                style={indent}
                aria-expanded={isOpen}
                onClick={() => { onToggle(node.path) }}
              >
                {isOpen
                  ? <IconChevronDownOutline14 className={css.chevron} />
                  : <IconChevronRightOutline14 className={css.chevron} />}
                {isOpen
                  ? <IconFolderOpen16 className={css.glyph} size={16} />
                  : <IconFolderClose16 className={css.glyph} size={16} />}
                <span className={css.rowLabel}>{node.name}</span>
              </button>
              {isOpen && (
                <TreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  selected={selected}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              )}
            </div>
          )
        }
        return (
          <button
            key={node.path}
            type="button"
            className={clsx(css.row, selected === node.path && css.selected)}
            style={{ paddingLeft: `${10 + depth * 16 + 18}px` }}
            aria-current={selected === node.path ? 'true' : undefined}
            onClick={() => { onOpen(node.path) }}
          >
            <NoteGlyph />
            <span className={css.rowLabel}>{node.name}</span>
          </button>
        )
      })}
    </>
  )
}

/** Full-text results, each with its folder path and the matching snippet. */
function ResultRows({ items, searching, selected, onOpen, t }: {
  items: readonly BrainSearchMatch[]
  searching: boolean
  selected: string | null
  onOpen: (path: string) => void
  t: BrainSectionProps['t']
}) {
  if (searching && items.length === 0) return <div className={css.status}>{t('loading')}</div>
  if (items.length === 0) return <div className={css.status}>{t('search.noMatches')}</div>
  return (
    <>
      {items.map(item => (
        <button
          key={item.path}
          type="button"
          className={clsx(css.result, selected === item.path && css.selected)}
          onClick={() => { onOpen(item.path) }}
        >
          <span className={css.resultTitle}>{item.title}</span>
          <span className={css.resultPath}>{item.path}</span>
          <span className={css.resultSnippet}>{item.snippet}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Render the brain window.
 * @param props - see {@link BrainModalProps}.
 * @returns the dialog (nothing in the page while closed).
 */
export function BrainModal({ open, onClose, list, search, read, refresh, t }: BrainModalProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<OpenNote | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [results, setResults] = useState<{ query: string; items: readonly BrainSearchMatch[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [copied, setCopied] = useState<'text' | 'path' | null>(null)

  const normalizedQuery = query.trim()

  useEffect(() => {
    if (normalizedQuery === '') {
      setResults(null)
      setSearching(false)
      return undefined
    }
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      search(normalizedQuery, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return
          setResults({ query: normalizedQuery, items: result.items })
          setSearching(false)
        },
        () => {
          if (controller.signal.aborted) return
          setResults({ query: normalizedQuery, items: [] })
          setSearching(false)
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalizedQuery, search])

  useEffect(() => {
    if (copied === null) return undefined
    const timer = window.setTimeout(() => { setCopied(null) }, COPIED_MS)
    return () => { window.clearTimeout(timer) }
  }, [copied])

  const toggleFolder = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openNote = (path: string): void => {
    setSelected(path)
    setNoteError(null)
    setReading(true)
    read(path, new AbortController().signal).then(
      (loaded) => {
        setNote(loaded)
        setReading(false)
      },
      (reason: unknown) => {
        setNote(null)
        setNoteError(reason instanceof Error ? reason.message : String(reason))
        setReading(false)
      },
    )
  }

  const copy = (kind: 'text' | 'path'): void => {
    if (note === null) return
    void navigator.clipboard.writeText(kind === 'text' ? note.content : note.path).then(
      () => { setCopied(kind) },
      () => undefined,
    )
  }

  const liveResults = results !== null && results.query === normalizedQuery ? results.items : []
  const vaultPath = list.status.path

  const sidebarBody = normalizedQuery !== ''
    ? <ResultRows items={liveResults} searching={searching} selected={selected} onOpen={openNote} t={t} />
    : list.state === 'loading'
      ? <div className={css.status}>{t('loading')}</div>
      : list.state === 'error'
        ? (
          <div className={css.status} role="status">
            <span>{t('error')}</span>
            <button type="button" className={css.linkButton} onClick={refresh}>{t('retry')}</button>
          </div>
        )
        : !list.status.configured
          ? <div className={css.status}>{t('empty.unconfigured')}</div>
          : list.tree.length === 0
            ? <div className={css.status}>{t('empty.none')}</div>
            : (
              <TreeRows
                nodes={list.tree}
                depth={0}
                expanded={expanded}
                selected={selected}
                onToggle={toggleFolder}
                onOpen={openNote}
              />
            )

  return (
    <Modal open={open} onClose={onClose} title={t('section')} closeLabel={t('close')} className={css.dialog as string} headless>
      <header className={css.header}>
        <div className={css.heading}>
          <IconThinkOutline16 className={css.headingIcon} size={20} />
          <h2 className={css.title}>{t('section')}</h2>
          {vaultPath !== undefined && vaultPath !== '' && (
            <span className={css.vaultPath} title={vaultPath}>{vaultPath}</span>
          )}
        </div>
        <label className={css.search}>
          <IconSearchOutline16 className={css.searchIcon} size={16} />
          <input
            className={css.searchInput}
            type="text"
            placeholder={t('search.placeholderAll')}
            aria-label={t('search.aria')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          {query !== '' && (
            <button type="button" className={css.clearButton} aria-label={t('search.clear')} onClick={() => { setQuery('') }}>
              <IconCloseFill14 />
            </button>
          )}
        </label>
        <button type="button" className={css.closeButton} aria-label={t('close')} onClick={onClose}>
          <IconCloseOutline16 size={16} />
        </button>
      </header>

      <div className={css.body}>
        <nav className={css.sidebar} aria-label={t('vault')}>
          <span className={css.sidebarLabel}>{normalizedQuery !== '' ? t('search.results') : t('vault')}</span>
          {sidebarBody}
        </nav>

        <article className={css.reader}>
          {note !== null && !reading && (
            <div className={css.readerBar}>
              <span className={css.crumb} title={note.path}>{note.path}</span>
              <div className={css.readerActions}>
                <button type="button" className={css.actionButton} onClick={() => { copy('text') }}>
                  <IconCopyOutline16 size={14} />
                  {copied === 'text' ? t('copied') : t('copy.text')}
                </button>
                <button type="button" className={css.actionButton} onClick={() => { copy('path') }}>
                  <IconCopyOutline16 size={14} />
                  {copied === 'path' ? t('copied') : t('copy.path')}
                </button>
              </div>
            </div>
          )}
          <div className={css.readerBody}>
            {reading
              ? <div className={css.status}>{t('loading')}</div>
              : noteError !== null
                ? <div className={css.status} role="status">{noteError}</div>
                : note === null
                  ? <div className={css.placeholder}>{t('reader.empty')}</div>
                  : (
                    <>
                      <h1 className={css.noteTitle}>{note.title !== '' ? note.title : t('note.untitled')}</h1>
                      <div className={css.markdown}><MarkdownText text={note.content} /></div>
                    </>
                  )}
          </div>
        </article>
      </div>

      <footer className={css.footer}>{t('hint.close')}</footer>
    </Modal>
  )
}
