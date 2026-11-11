import { expect, test } from 'claude-code/testing'

import type { Plan, SessionRecord } from './plan'
import {
  PAGE,
  PERIOD_LABEL,
  STATUS_LABEL,
  folderNames,
  folders,
  isStale,
  nextPeriod,
  nextStatus,
  resumeCommand,
  rowNote,
  shortDate,
  withOwn,
} from './query'
import type { Row } from './query'
import { plan, step } from './testkit'

// Noon UTC: the local date is the same in every zone a test may run in.
const NOW = '2026-11-11T12:00:00.000Z'
const day = (date: string): string => `2026-${date}T12:00:00.000Z`

const one = (id: string, updatedAt: string, status: Plan['status'] = 'active', goal = 'план ' + id): Plan => ({
  ...plan([step('1', 1, status === 'active' ? 'active' : 'done')]),
  id,
  goal,
  status,
  updatedAt,
})

const record = (sessionId: string, project: string, plans: Plan[], extra: Partial<SessionRecord> = {}): SessionRecord => ({
  v: 1,
  sessionId,
  project,
  plans,
  ...extra,
})

const RECORDS = [
  record('a', '/home/u/Demo', [one('p1', day('11-01'))]),
  record('b', '/home/u/Shop', [one('p1', day('11-09')), one('p2', day('11-10'), 'done')], { endedAt: day('11-09') }),
  record('c', '/home/u/Notes', [one('p1', day('11-10'))]),
  record('d', '/home/u/Shop', [one('p1', day('11-05'))]),
]
const SCOPE = {
  current: '/home/u/Demo',
  ownSession: 'a',
  now: NOW,
  query: '',
  status: 'open',
  period: 'all',
} as const

test('folders: текущая папка первой, остальные по свежести незаконченных планов', () => {
  expect(folders(RECORDS, SCOPE).map(f => [f.name, f.isCurrent, f.unfinished])).toEqual([
    ['Demo', true, 1],
    ['Notes', false, 1],
    ['Shop', false, 2],
  ])
})

test('folders: планы папки по убыванию даты, из разных сессий, закрытые не попадают', () => {
  const shop = folders(RECORDS, SCOPE).find(f => f.name === 'Shop')!
  expect(shop.rows.map(r => r.key)).toEqual(['b:p1', 'd:p1'])
  expect(shop.rows[0]).toMatchObject({ sessionId: 'b', project: '/home/u/Shop', isOwn: false, isEnded: true })
})

test('folders: папка без незаконченных планов не показывается', () => {
  const only = [record('b', '/home/u/Shop', [one('p1', day('11-09'), 'done')])]
  expect(folders(only, SCOPE)).toEqual([])
})

test('folders: свой план помечен isOwn', () => {
  expect(folders(RECORDS, SCOPE)[0]!.rows[0]!.isOwn).toBe(true)
})

test('withOwn подменяет свою запись свежей или добавляет её', () => {
  const fresh = record('a', '/home/u/Demo', [one('p1', day('11-11')), one('p2', day('11-11'))])
  expect(withOwn(RECORDS, fresh).find(r => r.sessionId === 'a')!.plans).toHaveLength(2)
  expect(withOwn(RECORDS, fresh)).toHaveLength(4)
  expect(withOwn(RECORDS, record('z', '/p', []))).toHaveLength(5)
  expect(withOwn(RECORDS, null)).toBe(RECORDS)
})

test('folderNames: последняя часть пути, при совпадении - две последние', () => {
  const names = folderNames(['/a/app', '/b/app', '/c/x'])
  expect([...names.entries()]).toEqual([
    ['/a/app', 'a/app'],
    ['/b/app', 'b/app'],
    ['/c/x', 'x'],
  ])
})

test('folders: одинаковые имена папок не смешиваются', () => {
  const twins = [record('b', '/a/app', [one('p1', day('11-09'))]), record('c', '/b/app', [one('p1', day('11-10'))])]
  expect(folders(twins, SCOPE).map(f => [f.name, f.rows.length])).toEqual([
    ['b/app', 1],
    ['a/app', 1],
  ])
})

test('resumeCommand экранирует одинарную кавычку в пути', () => {
  expect(resumeCommand("/home/u/it's mine", 'id1')).toBe(
    "cd '/home/u/it'\\''s mine' && claude --resume id1",
  )
  expect(resumeCommand('/home/u/Shop', 'b')).toBe("cd '/home/u/Shop' && claude --resume b")
})

test('shortDate: этот год - дд.мм, другой - дд.мм.гг', () => {
  expect(shortDate(day('11-09'), NOW)).toBe('09.11')
  expect(shortDate('2025-03-07T12:00:00.000Z', NOW)).toBe('07.03.25')
})

test('isStale: незаконченный план без изменений больше 30 дней', () => {
  expect(isStale(one('p1', '2026-10-11T11:00:00.000Z'), NOW)).toBe(true)
  expect(isStale(one('p1', '2026-10-13T12:00:00.000Z'), NOW)).toBe(false)
  expect(isStale(one('p1', '2026-09-01T12:00:00.000Z', 'done'), NOW)).toBe(false)
})

test('rowNote: сделан, брошен, этот чат, чат закрыт, ничего', () => {
  const row = (plan: Plan, extra: Partial<Row> = {}): Row => ({
    key: 'b:' + plan.id,
    sessionId: 'b',
    project: '/home/u/Shop',
    plan,
    isOwn: false,
    isEnded: false,
    ...extra,
  })
  expect(rowNote(row(one('p1', NOW, 'done')))).toBe('сделан')
  expect(rowNote(row(one('p1', NOW, 'abandoned'), { isOwn: true }))).toBe('брошен')
  expect(rowNote(row(one('p1', NOW), { isOwn: true }))).toBe('этот чат')
  expect(rowNote(row(one('p1', NOW), { isEnded: true }))).toBe('чат закрыт')
  expect(rowNote(row(one('p1', NOW)))).toBe(undefined)
})

test('PAGE - 30', () => {
  expect(PAGE).toBe(30)
})

// ------------------------------------------------------------------ filters

const ago = (days: number): string => new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString()

const AGES = record('b', '/home/u/Shop', [
  one('p1', ago(1)),
  one('p2', ago(1), 'done'),
  one('p3', ago(9)),
  one('p4', ago(9), 'abandoned'),
  one('p5', ago(40)),
  one('p6', ago(40), 'done'),
  one('p7', ago(200)),
  one('p8', ago(200), 'done'),
])

const shown = (status: 'open' | 'all' | 'closed', period: '7d' | '30d' | '6m' | 'all'): string[] =>
  folders([AGES], { ...SCOPE, status, period }).flatMap(f => f.rows.map(r => r.plan.id))

test('статус × период', () => {
  expect(shown('open', '7d')).toEqual(['p1'])
  expect(shown('open', '30d')).toEqual(['p1', 'p3'])
  expect(shown('open', '6m')).toEqual(['p1', 'p3', 'p5'])
  expect(shown('open', 'all')).toEqual(['p1', 'p3', 'p5', 'p7'])
  expect(shown('closed', '30d')).toEqual(['p2', 'p4'])
  expect(shown('closed', 'all')).toEqual(['p2', 'p4', 'p6', 'p8'])
  expect(shown('all', '7d')).toEqual(['p1', 'p2'])
  expect(shown('all', 'all')).toHaveLength(8)
})

test('счётчик незаконченных - по поиску и периоду, без фильтра статуса', () => {
  expect(folders([AGES], { ...SCOPE, status: 'closed', period: '30d' })[0]!.unfinished).toBe(2)
})

test('поиск по цели и шагам без учёта регистра', () => {
  const records = [
    record('b', '/home/u/Shop', [one('p1', ago(1), 'active', 'Оплата картой')]),
    record('c', '/home/u/Notes', [
      { ...one('p1', ago(2), 'active', 'Заметки'), steps: [{ id: '1', text: 'форма оплаты', weight: 1, status: 'active' }] },
      one('p2', ago(3), 'active', 'Другое'),
    ]),
  ]
  const found = (query: string) =>
    folders(records, { ...SCOPE, query }).flatMap(f => f.rows.map(r => r.key))
  expect(found('ОПЛАТ')).toEqual(['b:p1', 'c:p1'])
  expect(found('  оплат ')).toEqual(['b:p1', 'c:p1'])
  expect(found('нет такого')).toEqual([])
})

test('выброшенный шаг поиском не находится', () => {
  const records = [
    record('b', '/home/u/Shop', [
      { ...one('p1', ago(1)), steps: [{ id: '1', text: 'тайный шаг', weight: 1, status: 'dropped' }, { id: '2', text: 'а', weight: 1, status: 'active' }] },
    ]),
  ]
  expect(folders(records, { ...SCOPE, query: 'тайный' })).toEqual([])
})

test('кнопки-циклы и их подписи', () => {
  expect([nextStatus('open'), nextStatus('all'), nextStatus('closed')]).toEqual(['all', 'closed', 'open'])
  expect([nextPeriod('7d'), nextPeriod('30d'), nextPeriod('6m'), nextPeriod('all')]).toEqual(['30d', '6m', 'all', '7d'])
  expect(STATUS_LABEL).toEqual({ open: 'не закончено', all: 'всё', closed: 'закончено' })
  expect(PERIOD_LABEL).toEqual({ '7d': '7 дн', '30d': '30 дн', '6m': '6 мес', all: 'всё' })
})
