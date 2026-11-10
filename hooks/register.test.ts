import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from './plan'
import { TOOL_FULL } from './tool'

type World = { sessionId: string; registered: unknown[]; failSet: boolean; store: Map<string, unknown> }

// Everything beneath the mod that these tests do not look at.
const world = (on: On, entries: Record<string, unknown> = {}): World => {
  const store = new Map<string, unknown>(Object.entries(entries))
  const state: World = { sessionId: 'a', registered: [], failSet: false, store }
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
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return state
}

// The mod's own tool is not in the generated tool types until a session has
// loaded it, so calls to it are typed here.
type Answer = { result?: unknown; deny?: string; context?: readonly string[] }
const call = ($: { tool: { call: (input: never) => Promise<unknown> } }, input: object): Promise<Answer> =>
  $.tool.call(input as never) as Promise<Answer>

const START = { tool: TOOL_FULL, action: 'start', goal: 'Мод', finish: 'проверен', steps: [{ text: 'а' }, { text: 'б' }] }
const boot = { cwd: '/home/u/Demo', surface: 'terminal', isInteractive: true } as const

test('session.start регистрирует инструмент progress с isDeferred false', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  expect(w.registered).toHaveLength(1)
  expect(w.registered[0]).toMatchObject({ name: 'progress', isDeferred: false })
})

test('start основной сессией заводит план и пишет запись в хранилище', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  const out = await call($, START)
  expect(out.result).toBe('План заведён. 0% · 1◐ а · 2○')
  const stored = w.store.get('s:a') as SessionRecord
  expect(stored).toMatchObject({ v: 1, sessionId: 'a', project: '/home/u/Demo' })
  expect(stored.plans[0]).toMatchObject({ goal: 'Мод', status: 'active', createdAt: '2026-11-10T10:00:00.000Z' })
})

test('ошибка инструмента приходит модели как deny, запись не пишется', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  const out = await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(out.deny).toBe('Нет активного плана. Вызови progress с action: "start".')
  expect(w.store.get('s:a')).toBe(undefined)
})

test('вызов от субагента получает deny и состояние не меняет', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  const out = await call($, { ...START, agentId: 'a1' })
  expect(out.deny).toBe('план ведёт основная сессия')
  expect(w.store.get('s:a')).toBe(undefined)
})

test('смена id сессии: следующий вызов работает с записью новой сессии', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  w.sessionId = 'b'
  const out = await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(out.deny).toBe('Нет активного плана. Вызови progress с action: "start".')
  const first = w.store.get('s:a') as SessionRecord
  expect(first.plans[0]!.steps[0]!.status).toBe('active')
})

test('запись поднимается из хранилища после смены процесса', async ($, on) => {
  const kept: SessionRecord = {
    v: 1,
    sessionId: 'a',
    project: '/home/u/Demo',
    plans: [{ id: 'p1', goal: 'Старый', steps: [{ id: '1', text: 'а', weight: 1, status: 'active' }, { id: '2', text: 'б', weight: 1, status: 'pending' }], status: 'active', createdAt: 'x', updatedAt: '2026-11-09T10:00:00.000Z' }],
  }
  const w = world(on, { 's:a': kept })
  await $.session.start(boot)
  const out = await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(out.result).toBe('∞ · 1✓ 2◐ б · остался один шаг: отметь его до итогового ответа')
})

test('отметка drop в хранилище применяется при подъёме', async ($, on) => {
  const kept: SessionRecord = {
    v: 1,
    sessionId: 'a',
    project: '/home/u/Demo',
    plans: [{ id: 'p1', goal: 'Старый', steps: [{ id: '1', text: 'а', weight: 1, status: 'active' }], status: 'active', createdAt: 'x', updatedAt: '2026-11-09T10:00:00.000Z' }],
  }
  const w = world(on, { 's:a': kept, 'drop:a:p1': true })
  await $.session.start(boot)
  const out = await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(out.deny).toBe('Нет активного плана. Вызови progress с action: "start".')
  expect([...w.store.keys()]).toEqual(['s:a', 'meta:prunedAt'])
  expect((w.store.get('s:a') as SessionRecord).plans[0]!.status).toBe('abandoned')
})

test('отказ хранилища: инструмент отвечает успехом', async ($, on) => {
  const w = world(on)
  w.failSet = true
  await $.session.start(boot)
  const out = await call($, START)
  expect(out.result).toBe('План заведён. 0% · 1◐ а · 2○')
})
