#!/usr/bin/env node
/**
 * Drive the real teams composition through real agent turns and report the
 * durable result.
 *
 * The coordinator's scripted model saves a specialist and assigns it a task; the
 * worker's scripted model answers from the assignment it received. Everything
 * between those two model boundaries is the real harness: tool pipeline, teams
 * engine, scheduler, subagent service, and session persistence.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { routes } from './fixture.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('the teams composition driver requires a config path')

/** One durable event type sequence, plus the text the snapshot pins. */
interface SessionFacts {
  readonly id: string
  readonly parentSession?: string
  readonly eventTypes: string[]
  readonly coordination: string | null
  readonly assignment: string | null
  readonly userText: string[]
  readonly assistantText: string[]
  readonly toolNames: string[]
  readonly toolResults: string[]
}

const ctx = await boot('aseldev-teams-loader-composition', resolveConfigPath(configPath, undefined))

/** Call team_manage through the real tool pipeline and return its canonical state. */
async function teamTool(agent: Agent, action: Record<string, unknown>): Promise<{
  isError: boolean
  text: string
  value: { team?: { tasks?: readonly Record<string, unknown>[] } } | undefined
}> {
  const result = await ctx.tools.execute({
    callId: CallId(`teams-driver-${String(action.action)}`),
    name: 'team_manage',
    arguments: action,
    agent,
    signal: new AbortController().signal,
  }) as {
    isError?: unknown
    content?: readonly { type?: string; text?: unknown }[]
    value?: { team?: { tasks?: readonly Record<string, unknown>[] } }
  }
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join(' '),
    value: result.value,
  }
}

try {  const coordinator = ctx.agents.list()[0]
  if (coordinator === undefined) throw new Error('the composition created no agent')

  // One real turn: the scripted model walks save_specialist -> assign -> final.
  coordinator.followup(createUserMessage({
    content: [{ type: 'text', text: 'Set up a reader teammate and give it the assignment.' }],
    source: { kind: 'user' },
  }))
  await coordinator.whenIdle()

  const first = await teamTool(coordinator, { action: 'status' })
  const assigned = first.value?.team?.tasks?.[0]
  if (assigned === undefined) throw new Error(`the assignment never reached the store: ${first.text}`)

  // Wait for the worker's own scripted turn to settle the assignment.
  const settled = async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const current = (await teamTool(coordinator, { action: 'status' })).value?.team?.tasks?.[0]
      if (current !== undefined && current.status === 'done') return current
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const dump = await teamTool(coordinator, { action: 'status' })
    throw new Error('the assignment never settled: ' + dump.text)
  }
  const firstDone = await settled()

  // A follow-up to the SAME worker conversation, through the real scheduler.
  await teamTool(coordinator, {
    action: 'message',
    taskId: String(firstDone.id),
    message: 'Run the same assignment again.',
  })
  const secondDone = await settled()

  // Durable evidence: every session's persisted events.
  const sessionsDir = join(process.cwd(), '.sessions')
  const facts: SessionFacts[] = readdirSync(sessionsDir, { recursive: true })
    .map(entry => String(entry))
    .filter(entry => entry.includes('jsonl'))
    .flatMap((entry) => {
      const records = readFileSync(join(sessionsDir, entry), 'utf8').trimEnd().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
      const header = records[0] as { id?: unknown; parentSession?: unknown }
      const events = records.slice(1)
      const texts = (type: string, pick: (data: Record<string, unknown>) => string[]): string[] => events
        .filter(event => event.type === type)
        .flatMap(event => pick((event.data ?? {}) as Record<string, unknown>))
      // Text leaves anywhere in the event payload: `assistant/message` nests its
      // content, and the shape is not this test's business to pin.
      const blocks = (data: Record<string, unknown>): string[] => {
        const found: string[] = []
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) { for (const item of value) walk(item); return }
          if (value === null || typeof value !== 'object') return
          const record = value as Record<string, unknown>
          if (record.type === 'text' && typeof record.text === 'string') found.push(record.text)
          for (const nested of Object.values(record)) walk(nested)
        }
        walk(data)
        return found
      }
      // Tool-call names, for the stable transcript. The durable payload nests the
      // call, so collect every `name` leaf under a tool/call event.
      const toolNames = events
        .filter(event => event.type === 'tool/call')
        .flatMap((event) => {
          const found: string[] = []
          const walk = (value: unknown): void => {
            if (Array.isArray(value)) { for (const item of value) walk(item); return }
            if (value === null || typeof value !== 'object') return
            for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
              if (key === 'name' && typeof nested === 'string') found.push(nested)
              else walk(nested)
            }
          }
          walk(event.data ?? {})
          return found
        })
      const userText = texts('user/message', blocks)
      // Unique-preserving-order: a settlement notice can add a repeat coordinator
      // turn depending on timing, and a snapshot must pin content, not that race.
      const unique = (values: string[]): string[] => [...new Set(values)]
      return [{
        id: String(header.id),
        ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
        eventTypes: [...new Set(events.map(event => String(event.type)))].sort(),
        // The two prompt contributions this snapshot pins: the coordination
        // context and the assignment the worker was handed.
        coordination: userText.find(text => text.includes('Auto-continue budget') || text.includes('team worker')) ?? null,
        assignment: userText.find(text => text.startsWith('Assignment:')) ?? null,
        userText: texts('user/message', (data) => {
          const kind = (data.source as { kind?: unknown } | undefined)?.kind
          return kind === 'user' || kind === 'coordinator' ? blocks(data) : []
        }),
        assistantText: unique(texts('assistant/message', blocks)),
        toolNames,
        toolResults: unique(texts('tool/result', blocks)),
      }]
    })

  // ── disposal evidence ─────────────────────────────────────────────────────
  // Retain the tools SERVICE and the route recorder, tear the tree down, then ask
  // the retained references what is left. Reading them from a fresh `ctx` would
  // prove only that the context went away, not that every root contribution was
  // released; this is the HMR/unload path a real reload takes.
  const retainedTools = ctx.tools
  const report = {
    coordinator: String(coordinator.id),
    routes: [...routes],
    firstStatus: firstDone.status,
    firstResult: firstDone.result,
    secondStatus: secondDone.status,
    secondResult: secondDone.result,
    sessions: facts,
  }
  await ctx.fiber.dispose()
  const disposal = {
    // The registered tool must be gone from the retained registry.
    teamToolRemoved: retainedTools.get('team_manage') === undefined,
    // The web-server route disposer must have run; the recorder is fixture-owned.
    routesRemoved: routes.length === 0,
  }

  // Serialized AFTER disposal, so the report states post-teardown facts.
  process.stdout.write(`${JSON.stringify({ ...report, disposal })}\n`)
} catch (error: unknown) {
  // The tree must not outlive a failing run.
  await ctx.fiber.dispose().catch(() => {})
  throw error
}
