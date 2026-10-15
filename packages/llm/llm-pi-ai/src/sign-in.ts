/**
 * Account sign-in for catalog providers that authenticate through OAuth alone
 * (`openai-codex`: a ChatGPT Plus/Pro subscription). pi-ai ships each such
 * provider's login and refresh flow; this module runs the login on behalf of
 * a configuration surface, keeps the resulting token set as one credential in
 * the harness credential seam, and hands each request a fresh access token,
 * refreshing it shortly before it expires.
 *
 * The browser login listens for pi-ai's fixed OAuth callback on the host
 * (`http://localhost:1455/auth/callback` for Codex), so it completes on its
 * own when the browser runs on the same machine as `dsh`; otherwise the user
 * pastes the final redirect URL and {@link ProviderSignIn.handle} receives it
 * as `submit-code`.
 *
 * @module dsh-llm-pi-ai/sign-in
 */

import type { AuthInteraction, AuthPrompt, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmProviderSignInRequest, LlmProviderSignInState } from '@deepseek-ai/dsh-llm'

/** How long `start` and `submit-code` wait for the flow to report a URL or settle before answering. */
const STEP_SETTLE_MS = 15_000

/** How long a started login may wait for the user before it is abandoned. */
const LOGIN_TIMEOUT_MS = 10 * 60_000

/** An access token this close to expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * The credential reference one provider's token set is stored under.
 * @param provider - provider route key (e.g. `openai-codex`).
 * @returns the reference, e.g. `OPENAI_CODEX_OAUTH`.
 */
export function signInCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_OAUTH`
}

/** The stored token set; pi-ai's own credential with its type tag. */
type StoredCredential = OAuthCredential

/**
 * Parse a stored token set, refusing anything that is not one.
 * @param value - the raw credential value.
 * @param ref - the credential reference, for the error message.
 * @returns the token set.
 */
function parseStored(value: string, ref: string): StoredCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new LlmError(`llm-pi-ai: credential ${ref} is not a stored sign-in; sign in again from Settings → Models`, 'INVALID_CREDENTIAL')
  }
  const candidate = parsed as Partial<StoredCredential> | null
  if (
    candidate === null || typeof candidate !== 'object'
    || typeof candidate.access !== 'string' || candidate.access.length === 0
    || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
    || typeof candidate.expires !== 'number'
  ) {
    throw new LlmError(`llm-pi-ai: credential ${ref} is not a stored sign-in; sign in again from Settings → Models`, 'INVALID_CREDENTIAL')
  }
  return { ...candidate, type: 'oauth' } as StoredCredential
}

/** One login in progress. */
interface Flow {
  /** Aborts the login, its callback listener, and any pending prompt. */
  abort: AbortController
  /** What the flow has told the user so far. */
  view: LlmProviderSignInState
  /** Delivers a pasted code to the flow's manual-code prompt, once it asks. */
  submit?: ((code: string) => void) | undefined
  /** Resolves when the flow first reports a URL or code, or settles. */
  progressed: Promise<void>
  /** Settles when the login finishes, fails, or is cancelled. */
  done: Promise<void>
}

/** Construction inputs of {@link ProviderSignIn}. */
export interface ProviderSignInOptions {
  /** Provider route key the sign-in authenticates. */
  provider: string
  /** pi-ai's OAuth flow for that provider. */
  oauth: OAuthAuth
  /** The credential seam, read per call so a remounted provider is picked up. */
  credentials: () => CredentialProvider | undefined
  /** Reports a failed login or refresh; never receives a secret. */
  warn: (message: string) => void
}

/**
 * Sign-in state and token lifecycle for one OAuth-only provider route.
 */
export class ProviderSignIn {
  private readonly ref: string
  private flow: Flow | undefined
  private lastError: string | undefined
  private refreshing: Promise<string> | undefined

  /** @param options - see {@link ProviderSignInOptions}. */
  constructor(private readonly options: ProviderSignInOptions) {
    this.ref = signInCredentialRef(options.provider)
  }

  private store(): CredentialProvider {
    const credentials = this.options.credentials()
    if (credentials === undefined) {
      throw new LlmError(
        `llm-pi-ai: signing in to "${this.options.provider}" needs the credentials service to keep its tokens`,
        'NO_CREDENTIAL_STORE',
      )
    }
    return credentials
  }

  private async read(): Promise<StoredCredential | undefined> {
    const hit = await this.store().resolve(credentialRef(this.ref))
    if (hit === undefined || hit.value.length === 0) return undefined
    return parseStored(hit.value, this.ref)
  }

  private async write(credential: StoredCredential): Promise<void> {
    await this.store().set(credentialRef(this.ref), JSON.stringify(credential))
  }

  /**
   * A usable access token for the next request, refreshed first when it
   * expires within {@link REFRESH_MARGIN_MS}. Concurrent callers share one
   * refresh, because the provider rotates the refresh token on use.
   * @returns the access token to send as the request's api key.
   */
  async accessToken(): Promise<string> {
    const stored = await this.read()
    if (stored === undefined) {
      throw new LlmError(
        `llm-pi-ai: "${this.options.provider}" is not signed in; sign in from Settings → Models`,
        'MISSING_CREDENTIAL',
      )
    }
    if (stored.expires - Date.now() > REFRESH_MARGIN_MS) return this.requestKey(stored)
    this.refreshing ??= this.refresh(stored).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** The api key pi-ai's own derivation sends for a token set (the access token for Codex). */
  private async requestKey(credential: StoredCredential): Promise<string> {
    const auth = await this.options.oauth.toAuth(credential)
    if (auth.apiKey === undefined || auth.apiKey.length === 0) {
      throw new LlmError(`llm-pi-ai: the "${this.options.provider}" sign-in yields no request credential`, 'INVALID_CREDENTIAL')
    }
    return auth.apiKey
  }

  private async refresh(stored: StoredCredential): Promise<string> {
    let next: OAuthCredential
    try {
      // AselDev (pi-ai 1.2.0 compatibility): refresh now takes a signal; a
      // never-aborted one keeps the old behaviour (no extra timeout).
      next = await this.options.oauth.refresh(stored, new AbortController().signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.warn(`llm-pi-ai: refreshing the "${this.options.provider}" sign-in failed: ${message}`)
      throw new LlmError(
        `llm-pi-ai: the "${this.options.provider}" sign-in expired and could not be refreshed; sign in again from Settings → Models`,
        'AUTH',
        { cause: error },
      )
    }
    const credential: StoredCredential = { ...next, type: 'oauth' }
    await this.write(credential)
    return this.requestKey(credential)
  }

  /**
   * Answer one configuration-surface request.
   * @param request - the step to take.
   * @returns the state after the step.
   */
  async handle(request: LlmProviderSignInRequest): Promise<LlmProviderSignInState> {
    switch (request.action) {
      case 'status':
        return this.status()
      case 'start':
        return this.start()
      case 'submit-code':
        return this.submitCode(request.code ?? '')
      case 'cancel':
        this.cancel()
        return this.status()
      case 'sign-out':
        this.cancel()
        this.lastError = undefined
        await this.store().unset(credentialRef(this.ref))
        return this.status()
      default: {
        const never: never = request.action
        throw new LlmError(`llm-pi-ai: unknown sign-in action ${String(never)}`, 'INVALID_SIGN_IN')
      }
    }
  }

  private async status(): Promise<LlmProviderSignInState> {
    if (this.flow !== undefined) return { ...this.flow.view }
    if (this.lastError !== undefined) return { state: 'error', error: this.lastError }
    let stored: StoredCredential | undefined
    try {
      stored = await this.read()
    } catch (error) {
      return { state: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    return stored === undefined
      ? { state: 'signed-out' }
      : { state: 'signed-in', expiresAt: stored.expires }
  }

  private cancel(): void {
    const flow = this.flow
    if (flow === undefined) return
    this.flow = undefined
    flow.abort.abort()
  }

  private async start(): Promise<LlmProviderSignInState> {
    this.cancel()
    this.lastError = undefined
    // Fail before opening a callback listener when there is nowhere to keep the result.
    this.store()
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, LOGIN_TIMEOUT_MS)
    let progressedResolve!: () => void
    const progressed = new Promise<void>((resolve) => { progressedResolve = resolve })
    const flow: Flow = {
      abort,
      view: { state: 'pending' },
      progressed,
      done: Promise.resolve(),
    }
    // AselDev (pi-ai 1.2.0 compatibility): login needs `signal` set, as it already is here.
    const interaction: AuthInteraction & { signal: AbortSignal } = {
      signal: abort.signal,
      prompt: prompt => this.prompt(flow, prompt),
      notify: (event) => {
        if (event.type === 'auth_url') {
          flow.view = { ...flow.view, authUrl: event.url }
          progressedResolve()
        } else if (event.type === 'device_code') {
          flow.view = { ...flow.view, userCode: event.userCode, verificationUri: event.verificationUri }
          progressedResolve()
        }
      },
    }
    this.flow = flow
    flow.done = this.options.oauth.login(interaction).then(
      async (credential) => {
        await this.write({ ...credential, type: 'oauth' })
      },
    ).catch((error: unknown) => {
      // A cancelled or superseded login is not a failure the user needs to see.
      if (abort.signal.aborted && this.flow !== flow) return
      const message = abort.signal.aborted
        ? 'Sign-in timed out; start it again.'
        : error instanceof Error ? error.message : String(error)
      this.lastError = message
      this.options.warn(`llm-pi-ai: signing in to "${this.options.provider}" failed: ${message}`)
    }).finally(() => {
      clearTimeout(timer)
      if (this.flow === flow) this.flow = undefined
      progressedResolve()
    })
    await settleWithin(progressed, STEP_SETTLE_MS)
    return this.status()
  }

  private prompt(flow: Flow, prompt: AuthPrompt): Promise<string> {
    switch (prompt.type) {
      case 'select': {
        // The first option is pi-ai's default method (the browser login for Codex).
        const first = prompt.options[0]
        if (first === undefined) return Promise.reject(new Error('the sign-in offered no login method'))
        return Promise.resolve(first.id)
      }
      case 'manual_code':
        return new Promise<string>((resolve, reject) => {
          const cancelled = (): void => { reject(new Error('Login cancelled')) }
          if (flow.abort.signal.aborted || prompt.signal?.aborted === true) {
            cancelled()
            return
          }
          flow.abort.signal.addEventListener('abort', cancelled, { once: true })
          prompt.signal?.addEventListener('abort', cancelled, { once: true })
          flow.submit = (code) => {
            flow.submit = undefined
            resolve(code)
          }
        })
      case 'text':
      case 'secret':
        return Promise.reject(new Error(`the sign-in asked for input this page cannot collect: ${prompt.message}`))
      default: {
        const never: never = prompt
        return Promise.reject(new Error(`unknown sign-in prompt ${JSON.stringify(never)}`))
      }
    }
  }

  private async submitCode(code: string): Promise<LlmProviderSignInState> {
    const flow = this.flow
    const trimmed = code.trim()
    if (flow === undefined || trimmed.length === 0) return this.status()
    if (flow.submit === undefined) {
      throw new LlmError(`llm-pi-ai: the "${this.options.provider}" sign-in is not waiting for a pasted code`, 'INVALID_SIGN_IN')
    }
    flow.submit(trimmed)
    await settleWithin(flow.done, STEP_SETTLE_MS)
    return this.status()
  }
}

/**
 * Wait for a promise to settle, but no longer than a bound.
 * @param promise - the promise to wait for; its rejection is not observed here.
 * @param ms - the bound in milliseconds.
 * @returns a promise that resolves when either happens first.
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
  ]).finally(() => { clearTimeout(timer) })
}
