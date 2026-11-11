import { expect, test } from 'claude-code/testing'

import { MESSAGES, START, boot, call, raise, world } from './testworld'
import { TOOL_FULL } from './tool'

const pane = (bodyRows = 20) =>
  ({
    plugin: 'votaprogress',
    component: 'Pane',
    requestId: 'votaprogress',
    props: {
      title: 'Прогресс',
      isFocused: false,
      bodyColumns: 40,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('панель показывает проект, цель, счёт шагов и активный шаг, на каждой поверхности', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, { ...START, steps: [{ text: 'а' }, { text: 'б' }, { text: 'в', big: true }] })
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect((await ui.find({ type: 'Text', text: /^Demo$/ }))?.text).toBe('Demo')
    expect((await ui.find({ type: 'Text', text: /^Мод$/ }))?.text).toBe('Мод')
    expect((await ui.find({ type: 'Text', text: / из / }))?.text).toBe('1 из 3')
    expect(await ui.find({ type: 'Text', text: /%|█|░/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^финал/ }))?.text).toBe('финал: проверен')
    expect((await ui.find({ type: 'Text', text: /^◐/ }))?.text).toBe('◐ б')
    expect(await ui.find({ type: 'Text', text: /сейчас/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^○/ }))?.text).toBe('○ в')
    expect(await ui.find({ type: 'Text', text: /крупный/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /◆/ }))?.text).toBe('◆')
    await ui.unmount()
  }
})

test('без плана - строка «плана нет»', async ($, on) => {
  world(on)
  await $.session.start(boot)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /плана/ }))?.text).toBe('плана нет')
  expect(await ui.find({ type: 'Text', text: /^Demo$/ })).toBeDefined()
  await ui.unmount()
})

test('открытый финал: тот же счёт, строки финала нет', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, { tool: TOOL_FULL, action: 'start', goal: 'Разбор', steps: [{ text: 'а' }] })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: / из / }))?.text).toBe('0 из 1')
  expect(await ui.find({ type: 'Text', text: /∞/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^финал/ })).toBeUndefined()
  await ui.unmount()
})

test('в низкой панели сделанные сжаты в счётчик, хвост в «ещё N»', async ($, on) => {
  world(on)
  await $.session.start(boot)
  const steps = Array.from({ length: 10 }, (_, i) => ({ text: 'шаг ' + (i + 1) }))
  await call($, { ...START, steps })
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1', '2', '3'] })
  const ui = await $.ui.mount({ ...pane(9), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /сделано/ }))?.text).toBe('✓ 3 сделано')
  expect((await ui.find({ type: 'Text', text: /ещё/ }))?.text).toBe('… ещё 4')
  expect((await ui.findAll({ type: 'Text', text: /^[◐○]/ })).map(t => t.text)).toEqual(['◐ шаг 4', '○ шаг 5', '○ шаг 6'])
  await ui.unmount()
})

test('добавленные шаги меняют счёт, пометки «было» нет', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, START)
  await call($, { tool: TOOL_FULL, action: 'update', done: ['1'] })
  await call($, { tool: TOOL_FULL, action: 'update', add: [{ text: 'в' }, { text: 'г' }] })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: / из / }))?.text).toBe('1 из 4')
  expect(await ui.find({ type: 'Text', text: /было|%/ })).toBeUndefined()
  await ui.unmount()
})

test('закрытые планы сессии под «Раньше в этом чате», не больше трёх', async ($, on) => {
  world(on)
  await $.session.start(boot)

  for (const goal of ['Первый', 'Второй', 'Третий', 'Четвёртый']) {
    await call($, { tool: TOOL_FULL, action: 'start', goal, finish: 'ок', steps: [{ text: 'а' }] })
    await call($, { tool: TOOL_FULL, action: 'close', outcome: goal === 'Второй' ? 'abandoned' : 'done' })
  }

  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Раньше в этом чате$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^[✓×] / })).map(t => t.text)).toEqual([
    '✓ Четвёртый',
    '✓ Третий',
    '× Второй',
  ])
  expect(await ui.find({ type: 'Text', text: /^брошен$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Первый/ })).toBeUndefined()
  await ui.unmount()
})

test('место сжатия отмечено строкой между закрытыми планами', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, { tool: TOOL_FULL, action: 'start', goal: 'Первый', finish: 'ок', steps: [{ text: 'а' }] })
  await call($, { tool: TOOL_FULL, action: 'close', outcome: 'done' })
  await w.clock.advance(60 * 1000)
  await raise($).session.compact({ trigger: 'auto', messages: MESSAGES })
  await w.clock.advance(60 * 1000)
  await call($, { tool: TOOL_FULL, action: 'start', goal: 'Второй', finish: 'ок', steps: [{ text: 'а' }] })
  await call($, { tool: TOOL_FULL, action: 'close', outcome: 'done' })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: /^(✓ |-----)/ })).map(t => t.text)).toEqual([
    '✓ Второй',
    '----- сжатие -----',
    '✓ Первый',
  ])
  await ui.unmount()
})

test('отказ хранилища виден в панели', async ($, on) => {
  const w = world(on)
  w.failSet = true
  await $.session.start(boot)
  await call($, START)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /хранилище/ }))?.text).toBe(
    'хранилище заполнено, планы не сохраняются',
  )
  await ui.unmount()
})

test('первый start открывает панель, второй в той же сессии уже нет', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  expect(w.opened).toHaveLength(1)
  expect(w.opened[0]).toMatchObject({ id: 'votaprogress', title: 'Прогресс', columns: 48 })
  await call($, { tool: TOOL_FULL, action: 'start', goal: 'Второй', steps: [{ text: 'а' }] })
  expect(w.opened).toHaveLength(1)
})

test('запомненное закрытие: первый start панель не открывает', async ($, on) => {
  const w = world(on, { 'pref:paneClosed': true })
  await $.session.start(boot)
  await call($, START)
  expect(w.opened).toHaveLength(0)
  expect(w.statuses.at(-1)).toBe('Demo · Мод · 0/2 · сейчас: а')
})

// A person's close of the pane (`ui.close`, origin person) is a call on `$`,
// not an event a test can raise: that path is checked in a live session.

test('/progress открывает панель и сбрасывает запомненное закрытие', async ($, on) => {
  const w = world(on, { 'pref:paneClosed': true })
  await $.session.start(boot)
  const out = await raise($).command.run({ command: 'progress', args: '', origin: { kind: 'user' } })
  expect(out.text).toBe('Панель прогресса открыта.')
  expect(w.opened).toHaveLength(1)
  expect(w.store.has('pref:paneClosed')).toBe(false)
})

test('/progress, когда панель не поместилась', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  const out = await raise($).command.run({ command: 'progress', args: '', origin: { kind: 'user' } })
  expect(out.text).toBe('Панель не поместилась: план виден в строке под вводом.')
})

test('панель не нарисована: строка статуса показывает план', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  await call($, START)
  expect(w.statuses.at(-1)).toBe('Demo · Мод · 0/2 · сейчас: а')
})

test('панель нарисована: строки статуса нет', async ($, on) => {
  const w = world(on)
  await $.session.start(boot)
  await call($, START)
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses.at(-1)).toBe(undefined)
})

test('после конца хода «ждёт ответа» нет ни в строке, ни в панели', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  await call($, START)
  await raise($).turn.complete({ answer: 'ок', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.statuses.at(-1)).toBe('Demo · Мод · 0/2 · сейчас: а')
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ждёт ответа/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^◐/ }))?.text).toBe('◐ а')
  await ui.unmount()
})

test('длинный крупный шаг обрезается так, чтобы ◆ справа поместился в одну строку', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, { ...START, steps: [{ text: 'Закрыть панель, строка статуса, /progress и ещё', big: true }, { text: 'б' }] })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const left = (await ui.find({ type: 'Text', text: /^◐/ }))?.text ?? ''
  // 40 columns: the text, one space, then ◆.
  expect(left).toBe('◐ Закрыть панель, строка статуса, /pr…')
  expect([...left].length).toBe(40 - 1 - 1)
  await ui.unmount()
})

test('длинная цель обрезается под счёт шагов', async ($, on) => {
  world(on)
  await $.session.start(boot)
  await call($, { ...START, goal: 'ц'.repeat(60) })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^ц/ }))?.text).toBe('ц'.repeat(32) + '…')
  await ui.unmount()
})

test('план закрыт: строка статуса снимается', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await $.session.start(boot)
  await call($, START)
  expect(w.statuses.at(-1)).toBe('Demo · Мод · 0/2 · сейчас: а')
  await call($, { tool: TOOL_FULL, action: 'close', outcome: 'abandoned' })
  expect(w.statuses.at(-1)).toBe(undefined)
})
