// The engine beneath the mod, as the integration tests stand in for it.
// Not loaded by the mod.
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, UiCopyResult } from 'claude-code'

import { TOOL_FULL } from './tool'

export type World = {
  sessionId: string
  registered: unknown[]
  failSet: boolean
  /** Every store read is refused. */
  failGet: boolean
  /** `$.ui.open` is refused. */
  failOpen: boolean
  /** Whether the engine draws the mod's pane now; the terminal may widen later. */
  drawn: boolean
  /** The compaction is vetoed further down the chain. */
  compactSkip: boolean
  store: Map<string, unknown>
  /** Whether a pane the mod opens gets drawn. */
  isPlaced: boolean
  opened: { id: string; title?: string; columns?: number; focus?: true }[]
  /** Every `$.ui.status` the mod set, in order. */
  statuses: (string | undefined)[]
  /** The engine's clock: `advance` moves it on. */
  clock: MockClock
  /** What `$.ui.copy` answers. */
  copy: UiCopyResult
  /** Every text `$.ui.copy` was given, in order. */
  copied: string[]
  /** Every `$.ui.toast` text, in order. */
  toasts: string[]
}

export const world = (on: On, entries: Record<string, unknown> = {}): World => {
  const store = new Map<string, unknown>(Object.entries(entries))
  const state: World = {
    sessionId: 'a',
    registered: [],
    failSet: false,
    failGet: false,
    failOpen: false,
    drawn: false,
    compactSkip: false,
    store,
    isPlaced: true,
    opened: [],
    statuses: [],
    clock: undefined as unknown as MockClock,
    copy: { isCopied: true },
    copied: [],
    toasts: [],
  }
  on('store.get', (_, e) => (state.failGet ? { deny: 'store is down' } : { value: store.get(e.key) }))
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
  state.clock = mock.clock(on, { now: Date.parse('2026-11-10T10:00:00.000Z') })
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
    if (state.failOpen) {
      return { deny: 'no pane' }
    }

    state.opened.push(e)
    state.drawn = state.isPlaced

    return { value: state.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.panes', () => ({
    value: state.opened.slice(-1).map(one => ({
      id: one.id,
      title: one.title ?? one.id,
      isShown: state.drawn,
      isFocused: false,
      isPlaced: state.drawn,
    })),
  }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    state.copied.push(e.text)

    return { value: state.copy }
  })
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_, e) => (state.compactSkip ? { skip: 'test' } : { messages: e.messages }))
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

/** A transcript for `session.compact`: a compaction leaves at least one message. */
export const MESSAGES = [{ role: 'user', text: 'x', toolUses: [] }]
