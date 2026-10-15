/**
 * Account sign-in field for a provider whose directory entry carries
 * `signIn`: it replaces the API-key field on that provider's card. Every step
 * goes through `llm.signIn`; the host runs the browser login and keeps the
 * tokens, so this panel only ever sees the sign-in state. While a sign-in is
 * pending the panel re-reads the state every few seconds, because the login
 * completes in another browser window.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import panel from './SignInPanel.module.css'

/** How often a pending sign-in re-reads its state. */
const PENDING_POLL_MS = 2_000

/** The sign-in action the wire accepts. */
type SignInAction = Parameters<IApiClient['llm']['signIn']>[0]['action']

/** The sign-in state the wire returns. */
type SignInView = Extract<
  Awaited<ReturnType<IApiClient['llm']['signIn']>>['result'],
  { ok: true }
>['value']

/** Props of {@link SignInPanel}. */
export interface SignInPanelProps {
  /** Provider route id the sign-in authenticates. */
  provider: string
  /** Provider name shown in the button and hint. */
  displayName: string
  /** Wire face the panel drives. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every action (read-only settings, or the card is applying). */
  disabled: boolean
}

/**
 * Open a blank window inside the click that asked for it, so a popup blocker
 * lets it through; the sign-in page is loaded into it once the host answers.
 * @returns the window, or null when the browser refused one.
 */
function openBlankWindow(): Window | null {
  try {
    return window.open('about:blank', '_blank')
  } catch {
    // A browser that throws instead of returning null still gets the link the panel shows.
    return null
  }
}

/**
 * Render the sign-in field of one provider card.
 * @param props - see {@link SignInPanelProps}.
 * @returns the field.
 */
export function SignInPanel({ provider, displayName, api, t, disabled }: SignInPanelProps): ReactNode {
  const [view, setView] = useState<SignInView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [pasted, setPasted] = useState('')
  const named = (key: keyof typeof en): string => t(key).replace('{provider}', () => displayName)

  const call = useCallback(async (action: SignInAction, code?: string): Promise<SignInView | undefined> => {
    try {
      const response = await api.llm.signIn({ provider, action, ...code === undefined ? {} : { code } })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return undefined
      }
      setFailure(undefined)
      setView(response.result.value)
      return response.result.value
    } catch (error) {
      setFailure(messageOf(error))
      return undefined
    }
  }, [api.llm, provider])

  const step = async (action: SignInAction, code?: string): Promise<SignInView | undefined> => {
    setBusy(true)
    try {
      return await call(action, code)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void call('status') }, [call])

  const pending = view?.state === 'pending'
  useEffect(() => {
    if (!pending) return undefined
    const timer = setInterval(() => { void call('status') }, PENDING_POLL_MS)
    return () => { clearInterval(timer) }
  }, [pending, call])

  const start = async (): Promise<void> => {
    const popup = openBlankWindow()
    const next = await step('start')
    if (popup === null) return
    if (next?.state === 'pending' && next.authUrl !== undefined) {
      popup.opener = null
      popup.location.href = next.authUrl
    } else {
      popup.close()
    }
  }

  const submit = async (): Promise<void> => {
    const next = await step('submit-code', pasted.trim())
    if (next !== undefined && next.state !== 'pending') setPasted('')
  }

  const off = disabled || busy

  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('signInLabel')}</span>
      {view?.state === 'signed-in'
        ? (
          <div className={panel['row']}>
            <span className={panel['signedIn']} role="status">{t('signInSignedIn')}</span>
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={off}
              onClick={() => { void step('sign-out') }}
            >
              {t('signInSignOut')}
            </button>
          </div>
        )
        : pending
          ? (
            <div className={panel['pending']}>
              <p className={panel['text']} role="status" aria-live="polite">{t('signInPending')}</p>
              {view.userCode !== undefined && view.verificationUri !== undefined
                ? (
                  <p className={panel['text']}>
                    {`${t('signInDeviceCode').replace('{code}', () => view.userCode ?? '')} `}
                    <a href={view.verificationUri} target="_blank" rel="noopener noreferrer">{view.verificationUri}</a>
                  </p>
                )
                : null}
              {view.authUrl !== undefined
                ? (
                  <a className={panel['link']} href={view.authUrl} target="_blank" rel="noopener noreferrer">
                    {t('signInOpenAgain')}
                  </a>
                )
                : null}
              <label className={panel['paste']}>
                <span className={panel['text']}>{t('signInPasteLabel')}</span>
                <span className={panel['row']}>
                  <input
                    className={styles['input']}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={pasted}
                    placeholder={t('signInPastePlaceholder')}
                    disabled={off}
                    onChange={(event) => { setPasted(event.target.value) }}
                  />
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    disabled={off || pasted.trim().length === 0}
                    onClick={() => { void submit() }}
                  >
                    {t('signInSubmit')}
                  </button>
                </span>
              </label>
              <div>
                <button
                  type="button"
                  className={styles['linkButton']}
                  disabled={disabled}
                  onClick={() => { void step('cancel') }}
                >
                  {t('signInCancel')}
                </button>
              </div>
            </div>
          )
          : (
            <div className={panel['pending']}>
              <p className={panel['text']}>{named('signInHint')}</p>
              <div>
                <button
                  type="button"
                  className={styles['primaryButton']}
                  disabled={off || view === undefined}
                  onClick={() => { void start() }}
                >
                  {busy ? t('signInStarting') : view?.state === 'error' ? t('signInRetry') : named('signInButton')}
                </button>
              </div>
            </div>
          )}
      {view?.state === 'error' && view.error !== undefined
        ? <p className={styles['error']}>{`${t('signInFailed')}: ${view.error}`}</p>
        : null}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
    </div>
  )
}
