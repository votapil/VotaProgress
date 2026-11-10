import { expect, test } from 'claude-code/testing'

import { cleanText, compact, counts, percent } from './plan'
import { plan, step } from './testkit'

test('percent считает по весам', () => {
  expect(
    percent(plan([step('1', 1, 'done'), step('2', 3, 'active'), step('3', 1, 'pending')])),
  ).toBe(20)
})

test('percent не учитывает dropped', () => {
  expect(percent(plan([step('1', 1, 'done'), step('2', 3, 'dropped')]))).toBe(100)
})

test('percent null при открытом финале и без шагов', () => {
  expect(percent(plan([step('1', 1, 'done')], null))).toBe(null)
  expect(percent(plan([step('1', 1, 'dropped')]))).toBe(null)
})

test('counts без dropped', () => {
  expect(
    counts(plan([step('1', 1, 'done'), step('2', 1, 'dropped'), step('3', 1, 'pending')])),
  ).toEqual({ done: 1, total: 2 })
})

test('compact перечисляет шаги с номерами', () => {
  const p = plan([
    step('1', 1, 'done'),
    step('2', 1, 'active', 'тесты'),
    step('3', 1, 'pending'),
    step('4', 1, 'dropped'),
  ])
  expect(compact(p)).toBe('33% · 1✓ 2◐ тесты · 3○')
})

test('compact при открытом финале начинается с ∞', () => {
  expect(compact(plan([step('1', 1, 'done'), step('2', 1, 'active', 'пачка')], null))).toBe(
    '∞ · 1✓ 2◐ пачка',
  )
})

test('cleanText схлопывает переводы строк и режет до 120', () => {
  expect(cleanText('  a\n\n b\t c ')).toBe('a b c')
  expect(cleanText('я'.repeat(200)).length).toBe(120)
})
