import { expect, test } from 'claude-code/testing'

import { PlanError, closePlan, percent, shouldAutoClose, startPlan, updatePlan } from './plan'
import { EMPTY, T0, T1, T2, fails, plan, step } from './testkit'

const THREE = plan([step('1', 1, 'active'), step('2', 1, 'pending'), step('3', 1, 'pending')], null)
const THREE_WITH_FINISH = plan([
  step('1', 1, 'active'),
  step('2', 1, 'pending'),
  step('3', 1, 'pending'),
])
const TWO = plan([step('1', 1, 'active'), step('2', 1, 'pending')])
const ALL_DONE_OPEN = plan([step('1', 1, 'done'), step('2', 1, 'done')], null)

const throwsPlanError = (run: () => unknown): boolean => {
  try {
    run()
  } catch (error) {
    return error instanceof PlanError
  }

  return false
}

test('start: первый шаг активен, id p1', () => {
  const { record, closed } = startPlan(
    EMPTY,
    { goal: 'Мод', finish: 'проверен', steps: [{ text: 'а' }, { text: 'б', weight: 3 }] },
    T0,
  )
  expect(closed).toBe(undefined)
  expect(record.plans[0]).toMatchObject({
    id: 'p1',
    goal: 'Мод',
    finish: 'проверен',
    status: 'active',
    createdAt: T0,
    steps: [
      { id: '1', text: 'а', weight: 1, status: 'active' },
      { id: '2', text: 'б', weight: 3, status: 'pending' },
    ],
  })
})

test('start не мутирует входную запись', () => {
  startPlan(EMPTY, { goal: 'Мод', steps: [{ text: 'а' }] }, T0)
  expect(EMPTY.plans).toHaveLength(0)
})

test('start поверх незаконченного плана закрывает его как abandoned', () => {
  const first = startPlan(EMPTY, { goal: 'Первый', steps: [{ text: 'а' }, { text: 'б' }] }, T0).record
  const { record, closed } = startPlan(first, { goal: 'Второй', steps: [{ text: 'в' }] }, T1)
  expect(closed).toEqual({ goal: 'Первый', status: 'abandoned' })
  expect(record.plans.map(p => [p.id, p.status])).toEqual([
    ['p1', 'abandoned'],
    ['p2', 'active'],
  ])
})

test('start поверх плана со всеми сделанными шагами закрывает его как done', () => {
  const first = startPlan(EMPTY, { goal: 'Первый', steps: [{ text: 'а' }] }, T0).record
  const done = { ...first, plans: [updatePlan(first.plans[0]!, { done: ['1'] }, T1)] }
  expect(startPlan(done, { goal: 'Второй', steps: [{ text: 'в' }] }, T2).closed).toEqual({
    goal: 'Первый',
    status: 'done',
  })
})

test('start чистит тексты цели и шагов', () => {
  const { record } = startPlan(EMPTY, { goal: ' Мод\nprogress ', steps: [{ text: 'а\n б' }] }, T0)
  expect(record.plans[0]!.goal).toBe('Мод progress')
  expect(record.plans[0]!.steps[0]!.text).toBe('а б')
})

test('start: пустые шаги, вес 5, пустая цель, 31 шаг - ошибки', () => {
  expect(throwsPlanError(() => startPlan(EMPTY, { goal: 'x', steps: [] }, T0))).toBe(true)
  expect(
    throwsPlanError(() => startPlan(EMPTY, { goal: 'x', steps: [{ text: 'а', weight: 5 }] }, T0)),
  ).toBe(true)
  expect(throwsPlanError(() => startPlan(EMPTY, { goal: '  ', steps: [{ text: 'а' }] }, T0))).toBe(
    true,
  )
  const many = Array.from({ length: 31 }, (_, i) => ({ text: 'шаг ' + i }))
  expect(throwsPlanError(() => startPlan(EMPTY, { goal: 'x', steps: many }, T0))).toBe(true)
})

test('update done активирует следующий pending', () => {
  const p = updatePlan(THREE, { done: ['1'] }, T1)
  expect(p.steps.map(s => s.status)).toEqual(['done', 'active', 'pending'])
  expect(p.updatedAt).toBe(T1)
})

test('update принимает текст шага вместо номера', () => {
  expect(updatePlan(THREE, { done: ['шаг 1'] }, T1).steps[0]!.status).toBe('done')
})

test('update: явный active снимает прежний активный в pending', () => {
  const p = updatePlan(THREE, { active: '3' }, T1)
  expect(p.steps.map(s => s.status)).toEqual(['pending', 'pending', 'active'])
})

test('update add: новый шаг встаёт после after и получает следующий номер', () => {
  const p = updatePlan(THREE, { add: [{ text: 'новый', after: '1' }, { text: 'в конец', weight: 2 }] }, T1)
  expect(p.steps.map(s => [s.id, s.text])).toEqual([
    ['1', 'шаг 1'],
    ['4', 'новый'],
    ['2', 'шаг 2'],
    ['3', 'шаг 3'],
    ['5', 'в конец'],
  ])
  expect(p.steps[4]!.weight).toBe(2)
})

test('update drop: шаг становится dropped, номера не переиспользуются', () => {
  const dropped = updatePlan(THREE, { drop: ['3'] }, T1)
  expect(dropped.steps[2]!.status).toBe('dropped')
  expect(updatePlan(dropped, { add: [{ text: 'ещё' }] }, T2).steps[3]!.id).toBe('4')
})

test('update add после 100% роняет процент и пишет lastChange', () => {
  const full = updatePlan(updatePlan(TWO, { done: ['1'] }, T1), { done: ['2'] }, T1)
  expect(percent(full)).toBe(100)
  const p = updatePlan(full, { add: [{ text: 'ещё' }, { text: 'и ещё' }] }, T2)
  expect(percent(p)).toBe(50)
  expect(p.lastChange).toEqual({ added: 2, percentBefore: 100 })
  expect(shouldAutoClose(p)).toBe(false)
})

test('update без add стирает lastChange', () => {
  const added = updatePlan(TWO, { add: [{ text: 'ещё' }] }, T1)
  expect(updatePlan(added, { done: ['1'] }, T2).lastChange).toBe(undefined)
})

test('update с неизвестным номером бросает PlanError и не меняет план', () => {
  const before = JSON.stringify(THREE)
  const message = fails(() => updatePlan(THREE, { done: ['9'] }, T1))
  expect(/нет шага 9.*1, 2, 3/.test(message ?? '')).toBe(true)
  expect(throwsPlanError(() => updatePlan(THREE, { done: ['9'] }, T1))).toBe(true)
  expect(JSON.stringify(THREE)).toBe(before)
})

test('update: один шаг в done и drop - ошибка', () => {
  expect(throwsPlanError(() => updatePlan(THREE, { done: ['2'], drop: ['2'] }, T1))).toBe(true)
})

test('update: вес нового шага вне 1-3 - ошибка', () => {
  expect(throwsPlanError(() => updatePlan(THREE, { add: [{ text: 'x', weight: 0 }] }, T1))).toBe(true)
})

test('update finish: задаёт критерий, пустая строка открывает финал', () => {
  expect(updatePlan(THREE, { finish: 'залито' }, T1).finish).toBe('залито')
  expect('finish' in updatePlan(THREE_WITH_FINISH, { finish: ' ' }, T1)).toBe(false)
})

test('close done: активный done, pending dropped, процент 100', () => {
  const { plan: closed, dropped } = closePlan(THREE_WITH_FINISH, 'done', T2)
  expect(closed.steps.map(s => s.status)).toEqual(['done', 'dropped', 'dropped'])
  expect(dropped).toEqual(['шаг 2', 'шаг 3'])
  expect(percent(closed)).toBe(100)
  expect(closed).toMatchObject({ status: 'done', closedAt: T2, updatedAt: T2 })
})

test('close abandoned: шаги не меняются', () => {
  const { plan: closed, dropped } = closePlan(THREE, 'abandoned', T2)
  expect(closed.steps.map(s => s.status)).toEqual(['active', 'pending', 'pending'])
  expect(dropped).toEqual([])
  expect(closed.status).toBe('abandoned')
})

test('shouldAutoClose: true, когда финал задан и все шаги сделаны', () => {
  const full = updatePlan(updatePlan(TWO, { done: ['1'] }, T1), { done: ['2'] }, T1)
  expect(shouldAutoClose(full)).toBe(true)
})

test('shouldAutoClose: false при открытом финале и при несделанных шагах', () => {
  expect(shouldAutoClose(ALL_DONE_OPEN)).toBe(false)
  expect(shouldAutoClose(TWO)).toBe(false)
})
