// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect model search', () => {
  /** Two provider groups: a query has to narrow across groups, not just within one. */
  const GROUPS = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Long-context flagship' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  ]

  /** Mount the seat over the two-group catalog; the menu stays closed. */
  const mount = () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups: GROUPS }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ groups: GROUPS, current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    return { trigger: screen.getByRole('button', { name: /选择模型|当前/ }), select }
  }

  /** Mount the seat and drill into the model pane, the only pane that searches. */
  const bench = () => {
    const mounted = mount()
    fireEvent.click(mounted.trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    return { ...mounted, search: screen.getByRole('searchbox', { name: '搜索模型' }) }
  }

  /** The listed rows, read through the row titles the option buttons carry. */
  const rowTitles = (): (string | null)[] =>
    screen.queryAllByRole('menuitemradio').map(node => node.getAttribute('title'))

  it('keeps the field out of the root pane and narrows rows by name, id, description, or provider', () => {
    const { trigger } = mount()
    // The trigger opens on the Model/Effort root, which has no rows to search.
    fireEvent.click(trigger)
    expect(screen.queryByRole('searchbox')).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    expect(rowTitles()).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GPT-5'])

    fireEvent.change(search, { target: { value: 'gpt' } })
    expect(rowTitles()).toEqual(['GPT-5'])

    fireEvent.change(search, { target: { value: 'flagship' } })
    expect(rowTitles()).toEqual(['DeepSeek-V4-Pro'])

    // The provider name keeps that provider's whole group.
    fireEvent.change(search, { target: { value: 'deepseek' } })
    expect(rowTitles()).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])

    fireEvent.change(search, { target: { value: '  ' } })
    expect(rowTitles()).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GPT-5'])
  })

  it('reports an unmatched query and still selects from a narrowed list', async () => {
    const { search, select } = bench()

    fireEvent.change(search, { target: { value: 'no-such-model' } })
    expect(rowTitles()).toEqual([])
    expect(screen.getByText('没有匹配的模型。')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'gpt' } })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    })
  })

  it('drops the query when the menu closes and rejoins the unfiltered list', () => {
    const { trigger, search } = bench()
    fireEvent.change(search, { target: { value: 'gpt' } })
    expect(rowTitles()).toEqual(['GPT-5'])

    fireEvent.click(trigger)
    expect(screen.queryByRole('searchbox')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索模型' }).value).toBe('')
    expect(rowTitles()).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GPT-5'])
  })

  it('clears a typed query on Escape before backing out of the pane', () => {
    const { search } = bench()
    fireEvent.change(search, { target: { value: 'gpt' } })
    expect(rowTitles()).toEqual(['GPT-5'])

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(rowTitles()).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GPT-5'])

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('menuitem', { name: /模型/ })).toBeTruthy()
  })

  it('enters the row list from the search field with the arrow keys', () => {
    const { search } = bench()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('title')).toBe('DeepSeek-V4-Flash')
    // ArrowDown from a row keeps the modulo walk; ArrowUp from the first wraps to the last.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('title')).toBe('GPT-5')

    // Up from the field itself enters at the last row.
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('title')).toBe('GPT-5')
  })
})
