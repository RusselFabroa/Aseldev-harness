import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type {
  MarketInstallRequest, MarketInstallResult, MarketSearchRequest, MarketSearchResult,
} from '@deepseek-ai/dsh-market/types'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketLocaleKey } from './locales.ts'
import css from './MarketSettingsTab.module.css'

/** Registration-side Remote face the tab reads. */
export interface MarketSettingsTabInjected {
  /** Run one registry query. */
  search: (request: MarketSearchRequest) => Promise<MarketSearchResult>
  /** Install one confirmed plugin into the profile the Host serves. */
  install: (request: MarketInstallRequest) => Promise<MarketInstallResult>
}

type MarketEntry = MarketSearchResult['entries'][number]

/** Full component props assembled by the Settings slot renderer. */
export type MarketSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.market'>
  & InjectFace<MarketSettingsTabInjected>

/**
 * Query the tab browses with until the user submits their own. The registry
 * index matches text, and a DSH plugin is recognized by its `dsh` manifest
 * field rather than by name, so this is the browse heuristic, not a filter.
 */
const BROWSE_QUERY = 'dsh'

/** Quiet period after the last keystroke before the registry request. */
const SEARCH_DEBOUNCE_MS = 300

/** One catalog read's local lifecycle. */
type CatalogState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly entries: readonly MarketEntry[] }

/** One card's install lifecycle. */
type InstallState =
  | { readonly status: 'pending' }
  | { readonly status: 'installed'; readonly result: MarketInstallResult }
  | { readonly status: 'failed' }

type InstallStatus = 'idle' | InstallState['status']

/** React key, disclosure identity, and install-state key of one entry. */
function entryKey(entry: MarketEntry): string {
  return `${entry.name}@${entry.version}`
}

const INSTALL_LABEL = {
  idle: 'install',
  pending: 'installing',
  installed: 'installed',
  failed: 'retryInstall',
} as const satisfies Record<InstallStatus, MarketLocaleKey>

const INSTALL_ACCESSIBLE_LABEL = {
  idle: 'installNamed',
  pending: 'installingNamed',
  installed: 'installedNamed',
  failed: 'retryNamed',
} as const satisfies Record<InstallStatus, MarketLocaleKey>

/** Render one entry's install outcome: where it landed and whether it needs a restart. */
function installOutcome(result: MarketInstallResult, t: MarketSettingsTabProps['t']): ReactNode {
  return (
    <>
      <p className={css.installSuccess} role="status">
        {t('installedTitle', { name: result.package, version: result.version })}
      </p>
      <dl className={css.facts}>
        <div>
          <dt>{t('profileDirLabel')}</dt>
          <dd><code className={css.path}>{result.profileDir}</code></dd>
        </div>
      </dl>
      {result.restartRequired ? <p className={css.restart}>{t('restartNotice')}</p> : null}
    </>
  )
}

/** Test the market connection on request, then render search results and install controls. */
export function MarketSettingsTab({ search, install, t }: MarketSettingsTabProps): ReactNode {
  const detailsId = useId()
  const [query, setQuery] = useState(BROWSE_QUERY)
  const [submitted, setSubmitted] = useState(BROWSE_QUERY)
  const [attempt, setAttempt] = useState(0)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'idle' })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [installs, setInstalls] = useState<ReadonlyMap<string, InstallState>>(() => new Map())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Query edits take effect only after the first explicit connection test.
  useEffect(() => {
    if (attempt === 0) return
    const next = query.trim() === '' ? BROWSE_QUERY : query.trim()
    if (next === submitted) return
    const timer = setTimeout(() => { setSubmitted(next) }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [query, submitted, attempt])

  useEffect(() => {
    if (attempt === 0) return
    let current = true
    setCatalog({ status: 'loading' })
    void Promise.resolve().then(() => search({ query: submitted })).then(
      (result) => { if (current) setCatalog({ status: 'ready', entries: result.entries }) },
      () => { if (current) setCatalog({ status: 'error' }) },
    )
    return () => { current = false }
  }, [search, submitted, attempt])

  const recordInstall = (key: string, state: InstallState): void => {
    setInstalls((current) => {
      const next = new Map(current)
      next.set(key, state)
      return next
    })
  }

  const startInstall = (entry: MarketEntry): void => {
    const key = entryKey(entry)
    recordInstall(key, { status: 'pending' })
    void Promise.resolve().then(() => install({ package: entry.name })).then(
      (result) => {
        if (!mounted.current) return
        recordInstall(key, { status: 'installed', result })
        // The outcome (where it landed, whether a restart is due) is the point
        // of the click, so the card opens onto it.
        setExpanded(key)
      },
      () => { if (mounted.current) recordInstall(key, { status: 'failed' }) },
    )
  }

  return (
    <div className={css.section} aria-busy={catalog.status === 'loading'}>
      <header className={css.hero}>
        <span className={css.heroRule} aria-hidden="true" />
        <h3 className={css.heroTitle}>{t('heroTitle')}</h3>
        <p className={css.heroLead}>{t('heroLead')}</p>
      </header>

      <div className={css.controls}>
        <button
          className={css.retryButton}
          type="button"
          disabled={catalog.status === 'loading'}
          onClick={() => { setAttempt(value => value + 1) }}
        >
          {t('testConnection')}
        </button>
        <label className={css.search}>
          <IconSearchOutline16 aria-hidden="true" />
          <span className={css.visuallyHidden}>{t('search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            aria-label={t('search')}
            disabled={catalog.status === 'idle' || catalog.status === 'error'}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </label>
        {catalog.status === 'ready' ? (
          <p className={css.count} aria-live="polite">
            {t('resultCount', { count: catalog.entries.length })}
          </p>
        ) : null}
      </div>

      {catalog.status === 'idle' ? <p className={css.status}>{t('connectionHint')}</p> : null}
      {catalog.status === 'ready' ? <p className={css.status} role="status">{t('connected')}</p> : null}
      {catalog.status === 'loading' ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {catalog.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button
            className={css.retryButton}
            type="button"
            onClick={() => { setAttempt(value => value + 1) }}
          >
            {t('retry')}
          </button>
        </div>
      ) : null}
      {catalog.status === 'ready' && catalog.entries.length === 0
        ? <p className={css.status}>{submitted === BROWSE_QUERY ? t('empty') : t('emptySearch')}</p>
        : null}
      {catalog.status === 'ready' && catalog.entries.length > 0 ? (
        <ul className={css.results}>
          {catalog.entries.map((entry) => {
            const key = entryKey(entry)
            const state = installs.get(key)
            const status: InstallStatus = state?.status ?? 'idle'
            const open = expanded === key
            const panelId = `${detailsId}-${encodeURIComponent(key)}`
            return (
              <li
                className={clsx(css.card, open && css.cardOpen)}
                key={key}
                data-market-entry={key}
                data-open={open ? 'true' : undefined}
              >
                <div className={css.cardHead}>
                  <button
                    className={css.disclosure}
                    type="button"
                    aria-expanded={open}
                    aria-controls={panelId}
                    aria-label={`${entry.name} ${entry.version}`}
                    onClick={() => { setExpanded(current => current === key ? null : key) }}
                  >
                    <strong className={css.name} title={entry.name}>{entry.name}</strong>
                    <span className={css.version}>{entry.version}</span>
                    <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                  </button>
                  <button
                    className={clsx(css.install, status === 'failed' && css.installRetry)}
                    type="button"
                    data-status={status}
                    disabled={status === 'pending' || status === 'installed'}
                    aria-label={t(INSTALL_ACCESSIBLE_LABEL[status], { name: entry.name })}
                    onClick={() => { startInstall(entry) }}
                  >
                    {t(INSTALL_LABEL[status])}
                  </button>
                </div>
                <p className={css.description} data-clamped={open ? undefined : 'true'}>
                  {entry.description ?? t('noDescription')}
                </p>
                {status === 'failed' ? <p className={css.installFailure} role="alert">{t('installFailed')}</p> : null}
                {/* The panel element exists while collapsed so aria-controls always
                    resolves; only its content is conditional. */}
                <div className={css.details} id={panelId} hidden={!open}>
                  {open ? (
                    <>
                      <dl className={css.facts}>
                        <div>
                          <dt>{t('versionLabel')}</dt>
                          <dd>{entry.version}</dd>
                        </div>
                        <div>
                          <dt>{t('updatedLabel')}</dt>
                          <dd>
                            {entry.updatedAt === null
                              ? t('unreported')
                              : <time dateTime={entry.updatedAt}>{entry.updatedAt}</time>}
                          </dd>
                        </div>
                      </dl>
                      {state?.status === 'installed' ? installOutcome(state.result, t) : null}
                    </>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
