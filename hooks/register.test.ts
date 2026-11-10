import { expect, test } from 'claude-code/testing'

import type { SessionRecord } from './plan'
import { NUDGE, RULE } from './rule'
import { MESSAGES, START, boot, call, raise, world } from './testworld'
import type { World } from './testworld'
import { TOOL_FULL } from './tool'

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
  expect(out.result).toBe('План заведён. 1◐ а · 2○')
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
  expect(out.result).toBe('1✓ 2◐ б · остался один шаг: отметь его до итогового ответа')
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
  expect(out.result).toBe('План заведён. 1◐ а · 2○')
})

// ------------------------------------------------- lifecycle, rule, reminders

const edit = ($: Parameters<typeof call>[0], extra: object = {}) =>
  call($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b', ...extra })
const turnEnd = ($: unknown, reason: string, extra: object = {}) =>
  raise($).turn.complete({ answer: 'ок', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason, ...extra })
const compose = ($: unknown, tools: string[]) =>
  raise($).prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools, outputStyle: null, traits: [] })
const statusOf = (w: World, plan = 0): string => (w.store.get('s:a') as SessionRecord).plans[plan]!.status

test('prompt.compose добавляет секцию последней, когда инструмент в списке', async ($, on) => {
  world(on)
  const { sections } = await compose($, ['Bash', TOOL_FULL])
  expect(sections).toHaveLength(2)
  expect(sections[1]).toEqual({ id: 'votaprogress:rule', text: RULE, scope: 'session' })
})

test('prompt.compose без инструмента в списке секций не меняет', async ($, on) => {
  world(on)
  expect((await compose($, ['Bash'])).sections).toHaveLength(1)
})

test('третья правка без плана даёт NUDGE в context, четвёртая уже нет', async ($, on) => {
  world(on)
  await $.session.start(boot)
  expect((await edit($)).context).toBe(undefined)
  expect((await edit($)).context).toBe(undefined)
  expect((await edit($)).context).toEqual([NUDGE])
  expect((await edit($)).context).toBe(undefined)
})

test('Read счётчик не двигает; правки субагента не считаются', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, { tool: 'Read', file_path: '/x' })
  await edit($, { agentId: 'a1' })
  await edit($)
  await edit($)
  expect((await edit($, { agentId: 'a1' })).context).toBe(undefined)
  expect((await edit($)).context).toEqual([NUDGE])
})

test('при активном плане NUDGE не приходит', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, START)
  await edit($)
  await edit($)
  expect((await edit($)).context).toBe(undefined)
})

test('новое сообщение пользователя обнуляет счётчик', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await edit($)
  await edit($)
  await raise($).prompt.submit({ text: 'дальше' })
  expect((await edit($)).context).toBe(undefined)
})

test('после сжатия план приходит в context ближайшего результата и только один раз', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.compact({ trigger: 'auto', messages: MESSAGES })
  expect((await edit($)).context).toEqual(['Контекст был сжат. Текущий план: «Мод». 1◐ а · 2○'])
  expect((await edit($)).context).toBe(undefined)
})

test('после сжатия план приходит и с ближайшим сообщением пользователя', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.compact({ trigger: 'manual', messages: MESSAGES })
  const sent = await raise($).prompt.submit({ text: 'дальше' })
  expect(sent.context).toEqual(['Контекст был сжат. Текущий план: «Мод». 1◐ а · 2○'])
  expect((await edit($)).context).toBe(undefined)
})

test('сжатие транскрипта субагента флаг не ставит', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  expect((await edit($)).context).toBe(undefined)
})

test('turn.complete answer: все шаги сделаны, финал задан - план закрыт как done', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1', '2'] })
  expect(statusOf(w)).toBe('active')
  await turnEnd($, 'answer')
  expect(statusOf(w)).toBe('done')
})

test('turn.complete aborted и error: план остаётся активным', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1', '2'] })
  await turnEnd($, 'aborted')
  await turnEnd($, 'error')
  expect(statusOf(w)).toBe('active')
})

test('turn.complete answer при открытом финале: план остаётся активным', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, { tool: TOOL_FULL, action: 'start', goal: 'Открытый', steps: [{ text: 'а' }] })
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  await turnEnd($, 'answer')
  expect(statusOf(w)).toBe('active')
})

test('шаги добавлены после 100% в том же ходу: автозакрытия нет', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1', '2'] })
  await call($, { tool: TOOL_FULL, action: 'update', add: [{ text: 'ещё' }] })
  await turnEnd($, 'answer')
  expect(statusOf(w)).toBe('active')
})

test('turn.complete субагента ничего не закрывает', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1', '2'] })
  await turnEnd($, 'answer', { agentId: 'a1' })
  expect(statusOf(w)).toBe('active')
})

test('session.end clear: в записи endedAt и endReason, состояние сброшено', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.end({ reason: 'clear', sessionId: 'a', resume: { id: 'a' } })
  expect(w.store.get('s:a')).toMatchObject({ endedAt: '2026-11-10T10:00:00.000Z', endReason: 'clear' })
  w.sessionId = 'b'
  const out = await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(out.deny).toBe('Нет активного плана. Вызови progress с action: "start".')
})

test('session.end без планов ничего не пишет', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await raise($).session.end({ reason: 'prompt_input_exit', sessionId: 'a', resume: { id: 'a' } })
  expect(w.store.has('s:a')).toBe(false)
})

test('вызов progress после возобновления стирает endedAt', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.end({ reason: 'other', sessionId: 'a', resume: { id: 'a' } })
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect('endedAt' in (w.store.get('s:a') as object)).toBe(false)
})

test('сжатие precompute и отменённое сжатие план не повторяют', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  await raise($).session.compact({ trigger: 'precompute', messages: MESSAGES })
  expect((await edit($)).context).toBe(undefined)
  w.compactSkip = true
  await raise($).session.compact({ trigger: 'auto', messages: MESSAGES })
  expect((await edit($)).context).toBe(undefined)
})

test('сжатие без плана: заведённый позже план не объявляется сжатым', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await raise($).session.compact({ trigger: 'auto', messages: MESSAGES })
  await raise($).prompt.submit({ text: 'дальше' })
  await call($, START)
  expect((await edit($)).context).toBe(undefined)
})

test('панель дорисована позже: строка под вводом уходит', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  await call($, START)
  expect(typeof w.statuses.at(-1)).toBe('string')
  w.drawn = true
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('панель пропала без события: строка под вводом возвращается', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  expect(w.statuses.at(-1)).toBe(undefined)
  w.drawn = false
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  expect(typeof w.statuses.at(-1)).toBe('string')
})

test('session.end clear и resume снимают строку под вводом', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  await call($, START)
  expect(typeof w.statuses.at(-1)).toBe('string')
  await raise($).session.end({ reason: 'clear', sessionId: 'a', resume: { id: 'a' } })
  expect(w.statuses.at(-1)).toBe(undefined)
  w.sessionId = 'b'
  await call($, START)
  await raise($).session.end({ reason: 'resume', sessionId: 'b', resume: { id: 'b' } })
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('панель не открылась после записи плана: ответ всё равно успех', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  w.failOpen = true
  const out = await call($, START)
  expect(out.result).toBe('План заведён. 1◐ а · 2○')
  expect((w.store.get('s:a') as SessionRecord).plans).toHaveLength(1)
})

test('хранилище не читается: инструмент работает на пустой записи', async ($, on) => {
  const w = world(on)
  w.failGet = true
  await $.session.start(boot)
  const out = await call($, START)
  expect(out.result).toBe('План заведён. 1◐ а · 2○')
  expect((await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })).result).toBe('1✓ 2◐ б · остался один шаг: отметь его до итогового ответа')
})
