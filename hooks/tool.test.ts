import { expect, test } from 'claude-code/testing'

import type { SessionRecord } from './plan'
import { EMPTY, T0, T1, T2 } from './testkit'
import { TOOL, TOOL_FULL, handle, toolSpec } from './tool'

const START = { action: 'start', goal: 'Мод', finish: 'проверен', steps: [{ text: 'а' }, { text: 'б' }, { text: 'в' }] }
const started = (): SessionRecord => handle(EMPTY, START, T0).record

test('имена инструмента', () => {
  expect(TOOL).toBe('progress')
  expect(TOOL_FULL).toBe('mcp__votaprogress__progress')
  expect(toolSpec.name).toBe('progress')
  expect(toolSpec.isDeferred).toBe(false)
})

test('схема: action обязателен, три действия', () => {
  const schema = toolSpec.inputSchema as { required: string[]; properties: { action: { enum: string[] } } }
  expect(schema.required).toEqual(['action'])
  expect(schema.properties.action.enum).toEqual(['start', 'update', 'close'])
})

test('схема: у шага флажок big, веса нет', () => {
  type Step = { properties: Record<string, { type: string }> }
  const schema = toolSpec.inputSchema as {
    properties: { steps: { items: Step }; add: { items: Step } }
  }

  for (const step of [schema.properties.steps.items, schema.properties.add.items]) {
    expect(step.properties.big?.type).toBe('boolean')
    expect('weight' in step.properties).toBe(false)
  }
})

test('описание говорит, что субагенты план не ведут', () => {
  expect(toolSpec.description).toContain('Субагенты план не ведут: его ведёт основная сессия.')
})

test('start: big в шаге - крупный шаг', () => {
  const out = handle(EMPTY, { ...START, steps: [{ text: 'а', big: true }, { text: 'б' }] }, T0)
  expect(out.record.plans[0]!.steps.map(s => s.weight)).toEqual([3, 1])
})

test('start: план заведён', () => {
  const out = handle(EMPTY, START, T0)
  expect(out.isError).toBe(false)
  expect(out.text).toBe('План заведён. 1◐ а · 2○ 3○')
  expect(out.record.plans).toHaveLength(1)
})

test('start поверх активного плана называет закрытый', () => {
  const out = handle(started(), { action: 'start', goal: 'Второй', steps: [{ text: 'г' }] }, T1)
  expect(out.text).toBe('Прежний план «Мод» закрыт как abandoned. План заведён. 1◐ г')
})

test('update: компактный план в ответе', () => {
  const out = handle(started(), { action: 'update', done: ['1'] }, T1)
  expect(out.isError).toBe(false)
  expect(out.text).toBe('1✓ 2◐ б · 3○')
})

test('update: остался один шаг - напоминание', () => {
  const one = handle(started(), { action: 'update', done: ['1'] }, T1).record
  const out = handle(one, { action: 'update', done: ['2'] }, T2)
  expect(out.text).toBe('1✓ 2✓ 3◐ в · остался один шаг: отметь его до итогового ответа')
})

test('close done перечисляет отброшенные шаги', () => {
  const out = handle(started(), { action: 'close', outcome: 'done' }, T1)
  expect(out.isError).toBe(false)
  expect(out.text).toBe('План закрыт: done. Отброшены шаги: б; в.')
  expect(out.record.plans[0]!.status).toBe('done')
})

test('close abandoned без списка шагов', () => {
  expect(handle(started(), { action: 'close', outcome: 'abandoned' }, T1).text).toBe(
    'План закрыт: abandoned.',
  )
})

test('close без outcome - ошибка, план не тронут', () => {
  const before = started()
  const out = handle(before, { action: 'close' }, T1)
  expect(out.isError).toBe(true)
  expect(out.record).toBe(before)
})

test('update и close без активного плана - ошибка с подсказкой', () => {
  for (const input of [{ action: 'update', done: ['1'] }, { action: 'close', outcome: 'done' }]) {
    const out = handle(EMPTY, input, T0)
    expect(out.isError).toBe(true)
    expect(out.text).toBe('Нет активного плана. Вызови progress с action: "start".')
    expect(out.record).toBe(EMPTY)
  }
})

test('PlanError: текст ошибки и текущий план, запись не тронута', () => {
  const before = started()
  const out = handle(before, { action: 'update', done: ['9'] }, T1)
  expect(out.isError).toBe(true)
  expect(out.text).toBe('В плане нет шага 9. Есть шаги: 1, 2, 3. Сейчас: 1◐ а · 2○ 3○')
  expect(out.record).toBe(before)
})

test('PlanError при start без активного плана - без хвоста «Сейчас»', () => {
  const out = handle(EMPTY, { action: 'start', goal: 'x', steps: [] }, T0)
  expect(out.isError).toBe(true)
  expect(out.text).toBe('В плане должно быть от 1 до 30 шагов (steps).')
})

test('неизвестное действие и ввод не объектом', () => {
  for (const input of [{ action: 'finish' }, 'start', null, 42, []]) {
    const out = handle(EMPTY, input, T0)
    expect(out.isError).toBe(true)
    expect(out.text).toBe('Неизвестное действие. Доступны: start, update, close.')
  }
})

test('кривые типы полей не роняют разбор', () => {
  const out = handle(started(), { action: 'update', done: '1', add: 'x', drop: 5 }, T1)
  expect(out.isError).toBe(true)
  expect(out.record.plans[0]!.steps.map(s => s.status)).toEqual(['active', 'pending', 'pending'])
})

test('успешный вызов стирает endedAt и endReason', () => {
  const ended: SessionRecord = { ...started(), endedAt: T1, endReason: 'clear' }
  const out = handle(ended, { action: 'update', done: ['1'] }, T2)
  expect('endedAt' in out.record).toBe(false)
  expect('endReason' in out.record).toBe(false)
})

test('update goal: цель меняется через инструмент', () => {
  const out = handle(started(), { action: 'update', goal: 'Живая проверка' }, T1)
  expect(out.isError).toBe(false)
  expect(out.record.plans[0]!.goal).toBe('Живая проверка')
})
