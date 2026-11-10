// The engine beneath the mod, as the integration tests stand in for it.
// Not loaded by the mod.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOOL_FULL } from './tool'

export type World = {
  sessionId: string
  registered: unknown[]
  failSet: boolean
  store: Map<string, unknown>
  /** Whether a pane the mod opens gets drawn. */
  isPlaced: boolean
  opened: { id: string; title?: string; columns?: number }[]
  /** Every `$.ui.status` the mod set, in order. */
  statuses: (string | undefined)[]
}

export const world = (on: On, entries: Record<string, unknown> = {}): World => {
  const store = new Map<string, unknown>(Object.entries(entries))
  const state: World = {
    sessionId: 'a',
    registered: [],
    failSet: false,
    store,
    isPlaced: true,
    opened: [],
    statuses: [],
  }
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    if (state.failSet) {
      return { deny: 'store is full' }
    }

    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.clock(on, { now: Date.parse('2026-11-10T10:00:00.000Z') })
  on('session.id', () => ({ value: state.sessionId }))
  on('session.root', () => ({ value: '/home/u/Demo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => {
    state.registered.push(e)

    return { value: { tool: TOOL_FULL } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    state.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    state.opened.push(e)

    return { value: state.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', () => ({ skip: 'test' }))
  on('tool.call', () => ({ result: {} }))
  on('command.run', () => ({}))

  return state
}

// The mod's own tool is not in the generated tool types until a session has
// loaded it, so calls to it are typed here.
type Answer = { result?: unknown; deny?: string; context?: readonly string[] }

export const call = (
  $: { tool: { call: (input: never) => Promise<unknown> } },
  input: object,
): Promise<Answer> => $.tool.call(input as never) as Promise<Answer>

type Raise = {
  prompt: {
    compose: (e: object) => Promise<{ sections: { id: string; text: string; scope: string }[] }>
    submit: (e: object) => Promise<{ text: string; context?: readonly string[] }>
  }
  turn: { start: (e: object) => Promise<unknown>; complete: (e: object) => Promise<unknown> }
  session: { end: (e: object) => Promise<unknown>; compact: (e: object) => Promise<unknown> }
  command: { run: (e: object) => Promise<{ text?: string }> }
  ui: { close: (e: object) => Promise<unknown> }
}

/** Raises an event as the engine does, for events the kit types more narrowly. */
export const raise = ($: unknown): Raise => $ as Raise

export const START = {
  tool: TOOL_FULL,
  action: 'start',
  goal: 'Мод',
  finish: 'проверен',
  steps: [{ text: 'а' }, { text: 'б' }],
}

export const boot = { cwd: '/home/u/Demo', surface: 'terminal', isInteractive: true } as const
