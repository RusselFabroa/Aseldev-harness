/**
 * Fixture for the teams Loader-composition test.
 *
 * - A scripted `mock` LLM adapter, so the test drives real agent turns through
 *   the real loop with no key: the coordinator saves a specialist and assigns it
 *   a task, and the worker answers from the assignment it received. Only this
 *   external boundary is faked; every tool call, the scheduler, the store, the
 *   subagent service, and session persistence are real.
 * - A `webServer` stand-in that records route registrations instead of binding a
 *   port. The addon's route, guard, and HTTP handler remain the real ones.
 */

import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** The assignment text the worker is expected to have received. */
const ASSIGNMENT = 'Answer with WORKER_SEES.'

/** Routes the addon registered, for the driver to report. */
export const routes: string[] = []

/**
 * The assignment the worker was given: the first user message that opens with
 * `Assignment:`. Injected context such as a skills catalog also arrives as a
 * user message, so position alone does not identify it.
 */
function lastUserText(options: GenerateOptions): string {
  const texts = options.messages.flatMap((message) => {
    if (message.role !== 'user') return []
    return [message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(' ')]
  })
  return texts.find(text => text.startsWith('Assignment:')) ?? texts[0] ?? ''
}

/** Yield one complete tool call as its own block. */
async function* toolCall(id: string, name: string, input: Record<string, unknown>): AsyncGenerator<StreamChunk> {
  const payload = JSON.stringify(input)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: payload }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: payload } }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Yield one complete text answer. */
async function* answer(text: string): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Deterministic script, keyed per session.
 *
 * A session that can see `team_manage` is the coordinator; a session that cannot
 * is a worker, because the addon's per-child filter removes that schema. Turn
 * order then decides which scripted line comes next.
 */
class ScriptedAdapter extends LlmAdapter {
  private readonly steps = new Map<NonNullable<GenerateOptions['sessionId']>, number>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new Error('A loop request must carry its session identity')
    const step = this.steps.get(sessionId) ?? 0
    this.steps.set(sessionId, step + 1)

    const toolNames = options.tools?.map(tool => tool.name) ?? []

    if (toolNames.includes('team_manage')) {
      if (step === 0) {
        yield* toolCall('coordinator-save', 'team_manage', {
          action: 'save_specialist',
          // A `write` specialist, because this composition mounts no inspection
          // tool: a `read` specialist would (correctly) refuse to start rather
          // than run with an empty allow-list.
          specialist: { id: 'worker', name: 'Worker', mode: 'write', instructions: 'Answer from the assignment only. Literal {{placeholder}} must survive.' },
        })
        return
      }
      if (step === 1) {
        yield* toolCall('coordinator-assign', 'team_manage', {
          action: 'assign',
          specialistId: 'worker',
          title: 'Reader pass',
          prompt: ASSIGNMENT,
          files: ['note.txt'],
        })
        return
      }
      yield* answer('COORDINATOR_DONE')
      return
    }

    // A worker's first turn echoes the assignment it was given; later turns are
    // the follow-up results.
    yield* answer(step === 0 ? `WORKER_FIRST: ${lastUserText(options)}` : 'WORKER_AGAIN: second pass')
  }
}

export const name = 'aseldev-teams-composition-fixture'
export const inject = ['llm']

/**
 * Register the scripted model route and the web-server stand-in.
 * @param ctx - Loader context supplying the LLM seam.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  ctx.provide('webServer', {
    register(route: { kind: string; path: string }): () => void {
      routes.push(`${route.kind}:${route.path}`)
      return () => {
        const index = routes.indexOf(`${route.kind}:${route.path}`)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  })
}
