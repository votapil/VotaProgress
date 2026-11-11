import { expect, test } from 'claude-code/testing'

import { history } from './plan'
import type { HistoryRow, Plan, SessionRecord } from './plan'
import { EMPTY, plan, step } from './testkit'

const at = (hour: number): string => `2026-11-10T${String(hour).padStart(2, '0')}:00:00.000Z`

const closed = (id: string, hour: number, status: Plan['status'] = 'done'): Plan => ({
  ...plan([step('1', 1, 'done')]),
  id,
  goal: id,
  status,
  closedAt: at(hour),
  updatedAt: at(hour),
})

const record = (plans: Plan[], compactions?: string[]): SessionRecord => ({
  ...EMPTY,
  plans,
  ...(compactions ? { compactions } : {}),
})

const names = (rows: HistoryRow[]): string[] =>
  rows.map(row => ('plan' in row ? row.plan.id : '-----'))

test('history: закрытые планы, новые сверху, активный не входит', () => {
  const rows = history(record([closed('A', 10), closed('B', 12, 'abandoned'), plan([step('1', 1, 'active')])]), 3)
  expect(names(rows)).toEqual(['B', 'A'])
})

test('history: сжатие между планами - строка между ними', () => {
  expect(names(history(record([closed('A', 10), closed('B', 12)], [at(11)]), 3))).toEqual(['B', '-----', 'A'])
})

test('history: два сжатия между планами - одна строка', () => {
  const compactions = ['2026-11-10T10:20:00.000Z', '2026-11-10T11:40:00.000Z']
  expect(names(history(record([closed('A', 10), closed('B', 12)], compactions), 3))).toEqual(['B', '-----', 'A'])
})

test('history: сжатие после последнего закрытого плана - строка сверху', () => {
  expect(names(history(record([closed('A', 10), closed('B', 12)], [at(13)]), 3))).toEqual(['-----', 'B', 'A'])
})

test('history: сжатие до всех планов строки не даёт', () => {
  expect(names(history(record([closed('A', 10), closed('B', 12)], [at(9)]), 3))).toEqual(['B', 'A'])
})

test('history: не больше limit планов, сжатие под последним показанным не рисуется', () => {
  const plans = [closed('A', 10), closed('B', 12), closed('C', 14), closed('D', 16)]
  expect(names(history(record(plans, [at(11)]), 3))).toEqual(['D', 'C', 'B'])
})
