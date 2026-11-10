import { expect, test } from 'claude-code/testing'

import type { SessionRecord } from './plan'
import {
  applyDrops,
  emptyRecord,
  getPaneClosed,
  loadRecord,
  markDropped,
  prune,
  saveRecord,
  setPaneClosed,
} from './storage'
import type { Kv } from './storage'
import { T0, T1, plan, step } from './testkit'

const memory = () => {
  const map = new Map<string, unknown>()
  const kv: Kv & { map: Map<string, unknown>; failSet: boolean } = {
    map,
    failSet: false,
    get: async key => map.get(key),
    set: async (key, value) => {
      if (kv.failSet) {
        throw new Error('store is full')
      }

      map.set(key, JSON.parse(JSON.stringify(value)))
    },
    delete: async key => {
      map.delete(key)
    },
    keys: async () => [...map.keys()],
  }

  return kv
}

const DAY = 24 * 60 * 60 * 1000
const NOW = '2026-11-10T12:00:00.000Z'
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString()
const record = (sessionId: string, updatedAt: string, status: 'active' | 'done' = 'done'): SessionRecord => ({
  v: 1,
  sessionId,
  project: '/home/u/Demo',
  plans: [{ ...plan([step('1', 1, 'active')]), status, updatedAt }],
})

test('emptyRecord: версия 1, без планов', () => {
  expect(emptyRecord('a', '/p')).toEqual({ v: 1, sessionId: 'a', project: '/p', plans: [] })
})

test('save затем load возвращает ту же запись', async () => {
  const kv = memory()
  const rec = record('a', T0)
  expect(await saveRecord(kv, rec)).toBe(true)
  expect(await loadRecord(kv, 'a')).toEqual(rec)
  expect(await kv.keys()).toEqual(['s:a'])
})

test('load: нет записи - undefined', async () => {
  expect(await loadRecord(memory(), 'a')).toBe(undefined)
})

test('load: мусор, чужая v, чужой sessionId, plans не массив - undefined', async () => {
  const kv = memory()
  const bad = [
    'строка',
    42,
    null,
    [],
    { v: 2, sessionId: 'a', plans: [] },
    { v: 1, sessionId: 'b', plans: [] },
    { v: 1, sessionId: 'a', plans: 'x' },
  ]

  for (const value of bad) {
    kv.map.set('s:a', value)
    expect(await loadRecord(kv, 'a')).toBe(undefined)
  }
})

test('save возвращает false, когда set отказал, и не бросает', async () => {
  const kv = memory()
  kv.failSet = true
  expect(await saveRecord(kv, record('a', T0))).toBe(false)
})

test('applyDrops закрывает отмеченный активный план и удаляет отметку', async () => {
  const kv = memory()
  await markDropped(kv, 'a', 'p1')
  expect(await kv.keys()).toEqual(['drop:a:p1'])
  const rec = await applyDrops(kv, record('a', T0, 'active'), T1)
  expect(rec.plans[0]).toMatchObject({ status: 'abandoned', closedAt: T1 })
  expect(await kv.keys()).toEqual([])
})

test('applyDrops: отметка на закрытый план удаляется, план не меняется', async () => {
  const kv = memory()
  await markDropped(kv, 'a', 'p1')
  const before = record('a', T0, 'done')
  expect(await applyDrops(kv, before, T1)).toEqual(before)
  expect(await kv.keys()).toEqual([])
})

test('applyDrops не трогает отметки чужих сессий', async () => {
  const kv = memory()
  await markDropped(kv, 'b', 'p1')
  await applyDrops(kv, record('a', T0, 'active'), T1)
  expect(await kv.keys()).toEqual(['drop:b:p1'])
})

test('prune удаляет запись старше 365 дней вместе с отметками, свежую оставляет', async () => {
  const kv = memory()
  await saveRecord(kv, record('old', ago(366)))
  await saveRecord(kv, record('new', ago(364)))
  await markDropped(kv, 'old', 'p1')
  expect(await prune(kv, NOW)).toBe(1)
  expect((await kv.keys()).sort()).toEqual(['meta:prunedAt', 's:new'])
})

test('prune не чаще раза в сутки', async () => {
  const kv = memory()
  await saveRecord(kv, record('old', ago(366)))
  kv.map.set('meta:prunedAt', new Date(Date.parse(NOW) - 60 * 60 * 1000).toISOString())
  expect(await prune(kv, NOW)).toBe(0)
  expect(kv.map.has('s:old')).toBe(true)
})

test('prune удаляет и активные планы старше 365 дней', async () => {
  const kv = memory()
  await saveRecord(kv, record('old', ago(400), 'active'))
  expect(await prune(kv, NOW)).toBe(1)
})

test('prune пропускает мусор и запись без планов и без endedAt', async () => {
  const kv = memory()
  kv.map.set('s:junk', 'строка')
  kv.map.set('s:empty', { v: 1, sessionId: 'empty', project: '/p', plans: [] })
  kv.map.set('s:ended', { v: 1, sessionId: 'ended', project: '/p', plans: [], endedAt: ago(400) })
  expect(await prune(kv, NOW)).toBe(1)
  expect((await kv.keys()).sort()).toEqual(['meta:prunedAt', 's:empty', 's:junk'])
})

test('paneClosed по умолчанию false, запоминается', async () => {
  const kv = memory()
  expect(await getPaneClosed(kv)).toBe(false)
  await setPaneClosed(kv, true)
  expect(await getPaneClosed(kv)).toBe(true)
  await setPaneClosed(kv, false)
  expect(await getPaneClosed(kv)).toBe(false)
})

test('paneClosed: отказ хранилища не бросает', async () => {
  const kv = memory()
  kv.failSet = true
  await setPaneClosed(kv, true)
  expect(await getPaneClosed(kv)).toBe(false)
})
