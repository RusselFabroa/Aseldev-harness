// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketSettingsTab } from '../src/client/MarketSettingsTab.tsx'
import type {
  MarketSettingsTabInjected,
  MarketSettingsTabProps,
} from '../src/client/MarketSettingsTab.tsx'
import { en, type MarketLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Catalog = Awaited<ReturnType<MarketSettingsTabInjected['search']>>
type InstallResult = Awaited<ReturnType<MarketSettingsTabInjected['install']>>

const dictionaries: Record<string, string> = en
const t = ((key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  dictionaries[key]!.replace(/\{(\w+)\}/g, (match, name: string) =>
    params !== undefined && name in params ? String(params[name]) : match)) as MarketSettingsTabProps['t']

const ENTRIES: Catalog['entries'] = [
  {
    name: '@fixture/plugin-a',
    version: '1.2.3',
    description: 'Adds a demo tool.',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    name: '@fixture/plugin-b',
    version: '0.4.0',
    description: null,
    updatedAt: null,
  },
]

const INSTALLED: InstallResult = {
  package: '@fixture/plugin-a',
  version: '1.2.3',
  profileDir: '/home/asel/.dsh/profiles/web',
  restartRequired: true,
}

function answerCatalog(entries: Catalog['entries'] = ENTRIES): MarketSettingsTabInjected['search'] {
  return async () => ({ entries })
}

function answerInstall(request: { readonly package: string }): Promise<InstallResult> {
  return Promise.resolve({ ...INSTALLED, package: request.package })
}

function props(overrides: Partial<MarketSettingsTabInjected> = {}): MarketSettingsTabProps {
  return {
    t,
    search: answerCatalog(),
    install: answerInstall,
    ...overrides,
  } as unknown as MarketSettingsTabProps
}

describe('MarketSettingsTab', () => {
  it('waits for Test connection before reading the registry and showing results', async () => {
    const deferred = Promise.withResolvers<Catalog>()
    const search = vi.fn(() => deferred.promise)
    render(<MarketSettingsTab {...props({ search })} />)
    expect(search).not.toHaveBeenCalled()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    expect(screen.getByText(en.loading)).toBeTruthy()
    await waitFor(() => { expect(search).toHaveBeenCalledOnce() })
    expect(search).toHaveBeenCalledWith({ query: 'dsh' })

    await act(async () => { deferred.resolve({ entries: ENTRIES }) })

    expect(screen.getByRole('searchbox', { name: en.search })).toHaveProperty('value', 'dsh')
    expect(screen.getByRole('heading', { name: en.heroTitle })).toBeTruthy()
    expect(screen.getByText(en.resultCount.replace('{count}', '2'))).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('@fixture/plugin-a')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(screen.getByText('Adds a demo tool.')).toBeTruthy()
    expect(screen.getByText(en.noDescription)).toBeTruthy()
  })

  it('expands a card onto its version, update time, and full description', async () => {
    render(<MarketSettingsTab {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    const disclosure = await screen.findByRole('button', { name: '@fixture/plugin-a 1.2.3' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    const controls = disclosure.getAttribute('aria-controls') ?? ''
    expect(document.getElementById(controls)?.hasAttribute('hidden')).toBe(true)

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(controls)?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText(en.versionLabel)).toBeTruthy()
    expect(screen.getByText(en.updatedLabel)).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01T00:00:00.000Z')

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(controls)?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByText(en.updatedLabel)).toBeNull()

    const unversioned = await screen.findByRole('button', { name: '@fixture/plugin-b 0.4.0' })
    fireEvent.click(unversioned)
    expect(screen.getByText(en.unreported)).toBeTruthy()
  })

  it('installs the latest version and reports where it landed', async () => {
    const install = vi.fn<MarketSettingsTabInjected['install']>(async () => INSTALLED)
    render(<MarketSettingsTab {...props({ install })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    const button = await screen.findByRole('button', {
      name: en.installNamed.replace('{name}', '@fixture/plugin-a'),
    })
    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(en.installing)).toBeTruthy()

    expect(await screen.findByText(en.installedTitle
      .replace('{name}', '@fixture/plugin-a')
      .replace('{version}', '1.2.3'))).toBeTruthy()
    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith({ package: '@fixture/plugin-a' })
    expect(screen.getByText('/home/asel/.dsh/profiles/web')).toBeTruthy()
    expect(screen.getByText(en.restartNotice)).toBeTruthy()
    expect(screen.getByRole('button', {
      name: en.installedNamed.replace('{name}', '@fixture/plugin-a'),
    })).toBeTruthy()
  })

  it('omits the restart notice when the running process can mount the plugin', async () => {
    const install = vi.fn<MarketSettingsTabInjected['install']>(
      async request => ({ ...INSTALLED, package: request.package, restartRequired: false }),
    )
    render(<MarketSettingsTab {...props({ install })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    fireEvent.click(await screen.findByRole('button', {
      name: en.installNamed.replace('{name}', '@fixture/plugin-b'),
    }))
    expect(await screen.findByText(en.installedTitle
      .replace('{name}', '@fixture/plugin-b')
      .replace('{version}', '1.2.3'))).toBeTruthy()
    expect(screen.queryByText(en.restartNotice)).toBeNull()
  })

  it('reports a failed install and lets the user retry it', async () => {
    const install = vi.fn<MarketSettingsTabInjected['install']>()
      .mockRejectedValueOnce(new Error('package manager exited 1'))
      .mockResolvedValueOnce(INSTALLED)
    render(<MarketSettingsTab {...props({ install })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    fireEvent.click(await screen.findByRole('button', {
      name: en.installNamed.replace('{name}', '@fixture/plugin-a'),
    }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.installFailed)
    expect(screen.queryByText('package manager exited 1')).toBeNull()

    fireEvent.click(screen.getByRole('button', {
      name: en.retryNamed.replace('{name}', '@fixture/plugin-a'),
    }))
    expect(await screen.findByText(en.restartNotice)).toBeTruthy()
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('debounces typing into one request and tells no-match apart from an empty market', async () => {
    const search = vi.fn<MarketSettingsTabInjected['search']>(async () => ({ entries: ENTRIES }))
    render(<MarketSettingsTab {...props({ search })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    const field = await screen.findByRole('searchbox', { name: en.search })
    expect(search).toHaveBeenCalledTimes(1)

    search.mockImplementation(async () => ({ entries: [] }))
    fireEvent.change(field, { target: { value: '  no-such-plugin  ' } })
    expect(await screen.findByText(en.emptySearch)).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith({ query: 'no-such-plugin' })

    fireEvent.change(field, { target: { value: '   ' } })
    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith({ query: 'dsh' })
  })

  it('shows a generic failure and retries the same query', async () => {
    const search = vi.fn<MarketSettingsTabInjected['search']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: ENTRIES })
    render(<MarketSettingsTab {...props({ search })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(search).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText('@fixture/plugin-a')).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith({ query: 'dsh' })
  })

  it('contains a synchronous search failure and ignores results and failures after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as MarketSettingsTabInjected['search']
    const failed = render(<MarketSettingsTab {...props({ search: syncFailure })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const lateCatalog = Promise.withResolvers<Catalog>()
    const late = render(<MarketSettingsTab {...props({ search: () => lateCatalog.promise })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    late.unmount()
    await act(async () => { lateCatalog.resolve({ entries: ENTRIES }) })

    const lateFailure = Promise.withResolvers<Catalog>()
    const lateFailing = render(<MarketSettingsTab {...props({ search: () => lateFailure.promise })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    lateFailing.unmount()
    await act(async () => { lateFailure.reject(new Error('late failure')) })

    const lateInstall = Promise.withResolvers<InstallResult>()
    const installing = render(<MarketSettingsTab {...props({ install: () => lateInstall.promise })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    fireEvent.click(await screen.findByRole('button', {
      name: en.installNamed.replace('{name}', '@fixture/plugin-a'),
    }))
    installing.unmount()
    await act(async () => { lateInstall.resolve(INSTALLED) })

    const lateInstallFailure = Promise.withResolvers<InstallResult>()
    const failing = render(<MarketSettingsTab {...props({ install: () => lateInstallFailure.promise })} />)
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    fireEvent.click(await screen.findByRole('button', {
      name: en.installNamed.replace('{name}', '@fixture/plugin-a'),
    }))
    failing.unmount()
    await act(async () => { lateInstallFailure.reject(new Error('late install failure')) })
  })
})
