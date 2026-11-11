import { expect, test } from 'claude-code/testing'

import { cleanText, compact, counts } from './plan'
import { plan, step } from './testkit'

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
  expect(compact(p)).toBe('1✓ 2◐ тесты · 3○')
})

test('compact без процента и при открытом финале', () => {
  expect(compact(plan([step('1', 1, 'done'), step('2', 1, 'active', 'пачка')], null))).toBe(
    '1✓ 2◐ пачка',
  )
})

test('cleanText схлопывает переводы строк и режет до 120', () => {
  expect(cleanText('  a\n\n b\t c ')).toBe('a b c')
  expect(cleanText('я'.repeat(200)).length).toBe(120)
})
