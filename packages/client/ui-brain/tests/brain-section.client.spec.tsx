// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BrainListState } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { BrainSectionProps } from '../src/client/contract/slots.ts'
import { BrainSection } from '../src/client/BrainSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: BrainSectionProps['t'] = makeTranslate(zh, commonZh)

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function brainState(overrides: Partial<BrainListState> = {}): BrainListState {
  return {
    status: { configured: true }, tree: [], state: 'ready', error: null, ...overrides,
  }
}

function mount(overrides: Partial<BrainSectionProps> = {}) {
  const read = vi.fn(async (path: string) => ({ path, title: 'alpha', content: '# Alpha' }))
  const props: BrainSectionProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useBrain: hook(brainState({
      tree: [{
        kind: 'folder', name: 'Area', path: 'Area',
        children: [{ kind: 'note', name: 'alpha', path: 'Area/alpha.md' }],
      }],
    })),
    useSessions: hook({}) as BrainSectionProps['useSessions'],
    useWorkspaces: hook({}) as BrainSectionProps['useWorkspaces'],
    search: vi.fn(async () => ({ items: [] })),
    read,
    refresh: vi.fn(),
    t,
    ...overrides,
  }
  return { read, view: render(<BrainSection {...props} />) }
}

describe('BrainSection', () => {
  it('keeps the tree out of the sidebar until the button opens the window', () => {
    mount()
    expect(screen.queryByText('Area')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('open.aria') }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Area')).toBeTruthy()
  })

  it('expands a folder in place and opens a note in the reader', async () => {
    const { read } = mount()
    fireEvent.click(screen.getByRole('button', { name: t('open.aria') }))
    fireEvent.click(screen.getByText('Area'))
    fireEvent.click(screen.getByText('alpha'))
    await waitFor(() => { expect(read).toHaveBeenCalledWith('Area/alpha.md', expect.anything()) })
  })

  it('shows the unconfigured hint inside the window when no vault is set', () => {
    mount({ useBrain: hook(brainState({ status: { configured: false } })) })
    fireEvent.click(screen.getByRole('button', { name: t('open.aria') }))
    expect(screen.getByText(t('empty.unconfigured'))).toBeTruthy()
  })

  it('offers an icon button in the rail state', () => {
    mount({ wide: false })
    expect(screen.getByRole('button', { name: t('open.aria') })).toBeTruthy()
    expect(screen.queryByText(t('section'))).toBeNull()
  })
})
