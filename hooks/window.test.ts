import { expect, test } from 'claude-code/testing'

import { projectName, statusLine, windowSteps } from './plan'
import { plan, step } from './testkit'

const SEVEN = [
  step('1', 2, 'done'),
  step('2', 2, 'done'),
  step('3', 1, 'done'),
  step('4', 3, 'active', 'тесты'),
  step('5', 1, 'pending'),
  step('6', 1, 'pending'),
  step('7', 1, 'pending'),
]
const P45 = plan(SEVEN)
const OPEN4 = plan(
  [
    step('1', 1, 'done'),
    step('2', 1, 'done'),
    step('3', 1, 'done'),
    step('4', 1, 'done'),
    step('5', 1, 'active', 'пачка'),
  ],
  null,
  'Разбор',
)
const LONG_GOAL = plan([step('1', 1, 'active', 'ш'.repeat(100))], 'готово', 'ц'.repeat(100))

test('windowSteps: всё помещается', () => {
  expect(windowSteps(SEVEN, 10)).toEqual({ doneCount: 0, shown: SEVEN, more: 0 })
})

test('windowSteps: сжимает сделанные и хвост', () => {
  const w = windowSteps(SEVEN, 4)
  expect(w.doneCount).toBe(3)
  expect(w.shown.map(s => s.id)).toEqual(['4', '5'])
  expect(w.more).toBe(2)
})

test('windowSteps: сделанные сжаты, остальное помещается целиком', () => {
  expect(windowSteps(SEVEN, 5)).toEqual({ doneCount: 3, shown: SEVEN.slice(3), more: 0 })
})

test('windowSteps: в одну строку остаётся активный', () => {
  expect(windowSteps(SEVEN, 1).shown.map(s => s.id)).toEqual(['4'])
})

test('windowSteps: dropped не показываются', () => {
  const steps = [step('1', 1, 'dropped'), step('2', 1, 'active')]
  expect(windowSteps(steps, 10).shown.map(s => s.id)).toEqual(['2'])
})

test('statusLine: обычный план', () => {
  expect(statusLine('Demo', P45, false)).toBe(
    'Demo · Мод progress · 3/7 · сейчас: тесты',
  )
})

test('statusLine: открытый финал и ожидание ответа', () => {
  expect(statusLine('Demo', OPEN4, true)).toBe(
    'Demo · Разбор · 4/5 · ждёт ответа: пачка',
  )
})

test('statusLine: нет плана', () => {
  expect(statusLine('Demo', undefined, false)).toBe(undefined)
})

test('statusLine: длинные тексты режутся до 40 знаков, строка одна', () => {
  const line = statusLine('Demo', LONG_GOAL, false) ?? ''
  expect(line.includes('\n')).toBe(false)
  expect(line).toBe('Demo · ' + 'ц'.repeat(39) + '… · 0/1 · сейчас: ' + 'ш'.repeat(39) + '…')
})

test('statusLine: без активного шага хвоста нет', () => {
  const p = plan([step('1', 1, 'done')])
  expect(statusLine('Demo', p, false)).toBe('Demo · Мод progress · 1/1')
})

test('projectName берёт последнюю часть пути', () => {
  expect(projectName('/home/votapil/Demo')).toBe('Demo')
  expect(projectName('/home/votapil/Demo/')).toBe('Demo')
  expect(projectName('/')).toBe('/')
})

const JUMPED = [
  step('1', 1, 'pending'),
  step('2', 1, 'pending'),
  step('3', 1, 'active'),
  step('4', 1, 'pending'),
  step('5', 1, 'pending'),
]

test('windowSteps: активный шаг вне порядка всегда показан', () => {
  expect(windowSteps(JUMPED, 2)).toMatchObject({ shown: [JUMPED[2]], more: 4 })
  expect(windowSteps(JUMPED, 1).shown).toEqual([JUMPED[2]])
  expect(windowSteps(JUMPED, 4).shown.map(s => s.id)).toEqual(['3', '4', '5'])
})
