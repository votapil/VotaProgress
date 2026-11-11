import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import type { Plan, SessionRecord, Step } from './plan'
import { START, boot, call, raise, world } from './testworld'
import type { World } from './testworld'

const pane = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal') =>
  ({
    plugin: 'votaprogress',
    component: 'Pane',
    requestId: 'votaprogress',
    surface,
    props: {
      title: 'Прогресс',
      isFocused: false,
      bodyColumns: 48,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const noon = (date: string): string => `2026-${date}T12:00:00.000Z`

const st = (id: string, text: string, status: Step['status'], big = false): Step => ({
  id,
  text,
  weight: big ? 3 : 1,
  status,
})

const planOf = (id: string, goal: string, updatedAt: string, steps: Step[], status: Plan['status'] = 'active'): Plan => ({
  id,
  goal,
  steps,
  status,
  createdAt: updatedAt,
  updatedAt,
})

const SHOP: SessionRecord = {
  v: 1,
  sessionId: 'b',
  project: '/home/u/Shop',
  endedAt: noon('11-09'),
  plans: [
    planOf('p1', 'Оплата картой', noon('11-09'), [
      st('1', 'сервис', 'done'),
      st('2', 'форма', 'done'),
      st('3', 'проверка', 'active', true),
    ]),
  ],
}

const NOTES: SessionRecord = {
  v: 1,
  sessionId: 'c',
  project: '/home/u/Notes',
  plans: [
    planOf('p1', 'Заметки', noon('11-08'), [st('1', 'а', 'active')]),
    planOf('p2', 'Старое', noon('11-01'), [st('1', 'а', 'done')], 'done'),
  ],
}

const seeded = (on: Parameters<typeof world>[0], extra: Record<string, unknown> = {}): World =>
  world(on, { 's:b': SHOP, 's:c': NOTES, ...extra })

type Ui = Pick<Mounted, 'find' | 'findAll'>

const keys = async (ui: Ui, prefix: string): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith(prefix))

const text = async (ui: Ui, key: string): Promise<string | undefined> => (await ui.find({ key }))?.text

/** A session with its own plan, the pane switched to the overview. */
const overview = async ($: Engine) => {
  await $.session.start(boot)
  await call($, START)
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'all' })

  return ui
}

test('кнопка «все проекты» переключает на обзор: папки по порядку, текущая раскрыта, на каждой поверхности', async ($, on) => {
  seeded(on)
  await $.session.start(boot)
  await call($, START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await text(ui, 'all')).toBe('все проекты')
    await ui.press({ key: 'all' })
    expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Shop', 'f:/home/u/Notes'])
    expect(await text(ui, 'f:/home/u/Demo')).toBe('▾ Demo (текущий)')
    expect(await text(ui, 'f:/home/u/Shop')).toBe('▸ Shop')
    expect(await keys(ui, 'p:')).toEqual(['p:a:p1'])
    expect(await ui.find({ text: /%|∞|ждёт ответа/ })).toBeUndefined()
    await ui.press({ key: 'chat' })
    expect(await ui.find({ key: 'all' })).toBeDefined()
    await ui.unmount()
  }
})

test('заголовок папки со счётчиком, строка своего плана с датой и пометкой', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  expect((await ui.findAll({ type: 'Text', text: /не закончено$/ })).map(t => t.text)).toEqual([
    '1 не закончено',
    '1 не закончено',
    '1 не закончено',
  ])
  expect(await text(ui, 'p:a:p1')).toBe('◐ Мод')
  expect((await ui.find({ type: 'Text', text: /^0 из 2$/ }))?.text).toBe('0 из 2')
  expect((await ui.find({ type: 'Text', text: /этот чат/ }))?.text).toBe('10.11 · этот чат')
  await ui.unmount()
})

test('раскрыть папку и план: шаги, ◆, команда запуска и кнопки; раскрыт один план', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Shop' })
  expect(await text(ui, 'f:/home/u/Shop')).toBe('▾ Shop')
  expect(await text(ui, 'p:b:p1')).toBe('◐ Оплата картой')
  expect((await ui.find({ type: 'Text', text: /^2 из 3$/ }))?.text).toBe('2 из 3')
  expect((await ui.find({ type: 'Text', text: /чат закрыт/ }))?.text).toBe('09.11 · чат закрыт')
  expect(await ui.find({ type: 'Text', text: /claude --resume/ })).toBeUndefined()

  await ui.press({ key: 'p:b:p1' })
  expect((await ui.findAll({ type: 'Text', text: /^[✓◐○] / })).map(t => t.text)).toEqual([
    '✓ сервис',
    '✓ форма',
    '◐ проверка',
  ])
  expect(await ui.find({ type: 'Text', text: /^◆$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /claude --resume/ }))?.text).toBe(
    "cd '/home/u/Shop' && claude --resume b",
  )
  expect(await text(ui, 'copy')).toBe('копировать запуск')
  expect(await text(ui, 'drop')).toBe('выбросить')

  await ui.press({ key: 'f:/home/u/Notes' })
  await ui.press({ key: 'p:c:p1' })
  expect((await ui.findAll({ type: 'Text', text: /claude --resume/ })).map(t => t.text)).toEqual([
    "cd '/home/u/Notes' && claude --resume c",
  ])

  await ui.press({ key: 'p:c:p1' })
  expect(await ui.find({ type: 'Text', text: /claude --resume/ })).toBeUndefined()
  await ui.unmount()
})

test('свой план: вместо команды «это этот чат», кнопок нет', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'p:a:p1' })
  expect((await ui.find({ type: 'Text', text: /^это этот чат$/ }))?.text).toBe('это этот чат')
  expect(await ui.find({ key: 'copy' })).toBeUndefined()
  expect(await ui.find({ key: 'drop' })).toBeUndefined()
  await ui.unmount()
})

test('копировать запуск: сообщение об успехе и причина отказа', async ($, on) => {
  const w = seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Shop' })
  await ui.press({ key: 'p:b:p1' })
  await ui.press({ key: 'copy' })
  expect(w.copied).toEqual(["cd '/home/u/Shop' && claude --resume b"])
  expect(w.toasts).toEqual(['Команда скопирована'])

  w.copy = { isCopied: false, reason: 'no-clipboard' }
  await ui.press({ key: 'copy' })
  expect(w.toasts.at(-1)).toBe('Не скопировано: нет буфера обмена. Выдели команду вручную')
  await ui.unmount()
})

test('выбросить: отметка в хранилище, чужая запись не тронута, план уходит из незаконченных', async ($, on) => {
  const w = seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Shop' })
  await ui.press({ key: 'p:b:p1' })
  await ui.press({ key: 'drop' })
  expect(w.store.get('drop:b:p1')).toBe(true)
  expect(w.store.get('s:b')).toEqual(SHOP)
  expect(w.toasts).toEqual(['План выброшен'])
  expect(await ui.find({ key: 'p:b:p1' })).toBeUndefined()
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Notes'])
  await ui.unmount()
})

test('в папке 31 план: видны 30 и кнопка «ещё 30»', async ($, on) => {
  const plans = Array.from({ length: 31 }, (_, i) =>
    planOf('p' + (i + 1), 'План ' + (i + 1), new Date(Date.parse(noon('11-09')) - i * 60_000).toISOString(), [st('1', 'а', 'active')]),
  )
  seeded(on, { 's:b': { ...SHOP, plans } })
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Shop' })
  expect(await keys(ui, 'p:b:')).toHaveLength(30)
  expect(await text(ui, 'more:/home/u/Shop')).toBe('ещё 30')
  await ui.press({ key: 'more:/home/u/Shop' })
  expect(await keys(ui, 'p:b:')).toHaveLength(31)
  expect(await ui.find({ key: 'more:/home/u/Shop' })).toBeUndefined()
  await ui.unmount()
})

test('план без изменений больше 30 дней рисуется приглушённо', async ($, on) => {
  const old = { ...NOTES, plans: [planOf('p1', 'Заметки', noon('10-01'), [st('1', 'а', 'active')])] }
  seeded(on, { 's:c': old })
  const ui = await overview($)
  expect(await ui.find({ key: 'f:/home/u/Notes' })).toBeUndefined()
  await ui.press({ key: 'period' })
  await ui.press({ key: 'f:/home/u/Notes' })
  expect((await ui.find({ key: 'p:c:p1' }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'f:/home/u/Shop' })
  expect((await ui.find({ key: 'p:b:p1' }))?.props.dimColor).not.toBe(true)
  await ui.unmount()
})

test('при каждом открытии обзора текущая папка раскрыта, остальные свёрнуты', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Demo' })
  await ui.press({ key: 'f:/home/u/Shop' })
  expect(await text(ui, 'f:/home/u/Demo')).toBe('▸ Demo (текущий)')
  await ui.press({ key: 'chat' })
  await ui.press({ key: 'all' })
  expect(await text(ui, 'f:/home/u/Demo')).toBe('▾ Demo (текущий)')
  expect(await text(ui, 'f:/home/u/Shop')).toBe('▸ Shop')
  expect((await ui.find({ key: 'p:a:p1' }))?.props.autoFocus).toBe(true)
  await ui.unmount()
})

test('фокус при открытии на первом незаконченном плане текущей папки', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  expect((await ui.find({ key: 'p:a:p1' }))?.props.autoFocus).toBe(true)
  await ui.unmount()
})

test('/progress all открывает панель сразу на обзоре с клавиатурой; /progress оставляет вид; «этот чат» возвращает', async ($, on) => {
  const w = seeded(on)
  await $.session.start(boot)
  const out = await raise($).command.run({ command: 'progress', args: 'all', origin: { kind: 'user' } })
  expect(out.text).toBe('Обзор всех проектов открыт.')
  expect(w.opened.at(-1)).toMatchObject({ id: 'votaprogress', focus: true })
  const ui = await $.ui.mount(pane())
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Shop', 'f:/home/u/Notes'])

  await raise($).command.run({ command: 'progress', args: '', origin: { kind: 'user' } })
  expect(w.opened.at(-1)?.focus).toBe(undefined)
  expect(await keys(ui, 'f:')).toHaveLength(2)

  await ui.press({ key: 'chat' })
  expect((await ui.find({ type: 'Text', text: /^плана нет$/ }))?.text).toBe('плана нет')
  await ui.unmount()
})

test('/progress просит не больше трети ширины терминала', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)

  for (const [columns, asked] of [[120, 40], [200, 48], [60, 24]] as const) {
    await raise($).command.run({
      command: 'progress',
      args: '',
      origin: { kind: 'user' },
      presentation: { isFullscreen: true, columns },
    })
    expect(w.opened.at(-1)?.columns).toBe(asked)
  }
})

test('обзор читает хранилище при открытии и по «обновить», не на каждой отрисовке', async ($, on) => {
  const w = seeded(on)
  const ui = await overview($)
  w.store.set('s:d', { ...SHOP, sessionId: 'd', project: '/home/u/Site' })
  await ui.press({ key: 'f:/home/u/Shop' })
  expect(await ui.find({ key: 'f:/home/u/Site' })).toBeUndefined()
  await ui.press({ key: 'refresh' })
  expect(await text(ui, 'f:/home/u/Site')).toBe('▸ Site')
  await ui.unmount()
})

test('свой план в обзоре свежий без обновления', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await call($, { tool: 'mcp__votaprogress__progress', action: 'update', done: ['1'] })
  expect((await ui.find({ type: 'Text', text: /^1 из 2$/ }))?.text).toBe('1 из 2')
  await ui.unmount()
})

// ------------------------------------------------------- search and filters

test('поиск оставляет подходящие планы и раскрывает их папки', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  expect((await ui.find({ type: 'Input', key: 'q' }))?.props.label).toBe('Поиск: ')
  await ui.input({ key: 'q', text: 'ОПЛАТ', kind: 'change' })
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Shop'])
  expect(await text(ui, 'f:/home/u/Shop')).toBe('▾ Shop')
  expect(await keys(ui, 'p:')).toEqual(['p:b:p1'])
  await ui.input({ key: 'q', text: 'проверка', kind: 'change' })
  expect(await keys(ui, 'p:')).toEqual(['p:b:p1'])
  await ui.unmount()
})

test('поиск сворачивает раскрытый план и сбрасывает «ещё 30»', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'f:/home/u/Shop' })
  await ui.press({ key: 'p:b:p1' })
  expect(await ui.find({ type: 'Text', text: /claude --resume/ })).toBeDefined()
  await ui.input({ key: 'q', text: 'оплат', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /claude --resume/ })).toBeUndefined()
  await ui.unmount()
})

test('статус по кругу: всё и закончено показывают историю со значками и пометками', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  expect(await text(ui, 'status')).toBe('Статус: не закончено')
  await ui.press({ key: 'status' })
  expect(await text(ui, 'status')).toBe('Статус: всё')
  await ui.press({ key: 'f:/home/u/Notes' })
  expect(await keys(ui, 'p:c:')).toEqual(['p:c:p1', 'p:c:p2'])
  expect(await text(ui, 'p:c:p2')).toBe('✓ Старое')
  expect((await ui.find({ type: 'Text', text: /сделан$/ }))?.text).toBe('01.11 · сделан')

  await ui.press({ key: 'status' })
  expect(await text(ui, 'status')).toBe('Статус: закончено')
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Notes'])
  expect(await keys(ui, 'p:')).toEqual(['p:c:p2'])

  await ui.press({ key: 'status' })
  expect(await text(ui, 'status')).toBe('Статус: не закончено')
  await ui.unmount()
})

test('у закрытого плана чужой сессии есть «копировать запуск», нет «выбросить»', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'status' })
  await ui.press({ key: 'f:/home/u/Notes' })
  await ui.press({ key: 'p:c:p2' })
  expect(await ui.find({ key: 'copy' })).toBeDefined()
  expect(await ui.find({ key: 'drop' })).toBeUndefined()
  await ui.unmount()
})

test('период по кругу: 30 дн, 6 мес, всё, 7 дн', async ($, on) => {
  const old = { ...NOTES, plans: [planOf('p1', 'Заметки', noon('10-01'), [st('1', 'а', 'active')])] }
  seeded(on, { 's:c': old })
  const ui = await overview($)
  expect(await text(ui, 'period')).toBe('Период: 30 дн')
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Shop'])
  await ui.press({ key: 'period' })
  expect(await text(ui, 'period')).toBe('Период: 6 мес')
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Shop', 'f:/home/u/Notes'])
  await ui.press({ key: 'period' })
  expect(await text(ui, 'period')).toBe('Период: всё')
  await ui.press({ key: 'period' })
  expect(await text(ui, 'period')).toBe('Период: 7 дн')
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Shop'])
  await ui.unmount()
})

test('ничего не найдено: строка и кнопка сброса фильтров', async ($, on) => {
  seeded(on)
  const ui = await overview($)
  await ui.press({ key: 'status' })
  await ui.press({ key: 'period' })
  await ui.input({ key: 'q', text: 'нет такого', kind: 'change' })
  expect((await ui.find({ type: 'Text', text: /ничего/ }))?.text).toBe('ничего не найдено')
  expect(await text(ui, 'reset')).toBe('сбросить фильтры')
  await ui.press({ key: 'reset' })
  expect(await ui.find({ type: 'Text', text: /ничего/ })).toBeUndefined()
  expect(await text(ui, 'status')).toBe('Статус: не закончено')
  expect(await text(ui, 'period')).toBe('Период: 30 дн')
  expect((await ui.find({ type: 'Input', key: 'q' }))?.props.value).toBe('')
  expect(await keys(ui, 'f:')).toEqual(['f:/home/u/Demo', 'f:/home/u/Shop', 'f:/home/u/Notes'])
  await ui.unmount()
})
