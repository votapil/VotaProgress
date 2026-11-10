// The `progress` tool: what the model sees, and what one call does to a
// session's record. Pure: the hooks module wires it to the engine.

import type { ToolSpec } from 'claude-code'

import { PlanError, activePlan, closePlan, compact, startPlan, updatePlan } from './plan'
import type { Plan, SessionRecord, StartInput, UpdateInput } from './plan'

export const TOOL = 'progress'
export const TOOL_FULL = 'mcp__votaprogress__progress'

const STEP = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Шаг одной короткой фразой.' },
    weight: { type: 'integer', enum: [1, 2, 3], description: '1 мелкий (по умолчанию), 2 обычный, 3 крупный.' },
  },
  required: ['text'],
}

export const toolSpec: ToolSpec = {
  name: TOOL,
  description: [
    'Ведёт план текущей задачи: пользователь видит его в панели и в строке под вводом.',
    'start - завести план: goal (цель), finish (критерий конца; не передавай, если финал открыт), steps (шаги по порядку). Первый шаг сразу активен.',
    'update - изменить план: done (номера сделанных шагов; следующий шаг активируется сам), active (сделать шаг активным вне порядка), add (новые шаги, after - после какого номера), drop (убрать шаги), finish (новый критерий конца), goal (переименовать цель).',
    'close - закрыть план: outcome done или abandoned. План с критерием конца закрывается сам, когда все шаги сделаны и ход закончен.',
    'Закрыл шаг - один вызов update. Ответ всегда содержит план с номерами шагов.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'update', 'close'] },
      goal: { type: 'string', description: 'start: цель задачи, одной фразой, без названия проекта. update: новая формулировка цели.' },
      finish: { type: 'string', description: 'start, update: по чему понятно, что задача закончена.' },
      steps: { type: 'array', items: STEP, description: 'start: шаги плана, от 1 до 30.' },
      done: { type: 'array', items: { type: 'string' }, description: 'update: номера сделанных шагов.' },
      active: { type: 'string', description: 'update: номер шага, который берёшь в работу вне порядка.' },
      add: {
        type: 'array',
        items: {
          ...STEP,
          properties: { ...STEP.properties, after: { type: 'string', description: 'После какого номера вставить; без него - в конец.' } },
        },
        description: 'update: новые шаги.',
      },
      drop: { type: 'array', items: { type: 'string' }, description: 'update: номера шагов, которые больше не нужны.' },
      outcome: { type: 'string', enum: ['done', 'abandoned'], description: 'close: чем закончилось.' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

const NO_PLAN = 'Нет активного плана. Вызови progress с action: "start".'
const UNKNOWN = 'Неизвестное действие. Доступны: start, update, close.'

const refs = (value: unknown, name: string): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new PlanError(`Поле ${name} должно быть списком номеров шагов.`)
  }

  return value.map(String)
}

const list = <T>(value: unknown, name: string): T[] | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new PlanError(`Поле ${name} должно быть списком.`)
  }

  return value as T[]
}

const replace = (record: SessionRecord, plan: Plan): SessionRecord => ({
  ...record,
  plans: record.plans.map(one => (one.id === plan.id ? plan : one)),
})

const awake = (record: SessionRecord): SessionRecord => {
  const { endedAt: _endedAt, endReason: _endReason, ...rest } = record

  return rest
}

/** Runs one call against the record. On an error the record comes back untouched. */
export const handle = (
  record: SessionRecord,
  input: unknown,
  now: string,
): { record: SessionRecord; text: string; isError: boolean } => {
  const fail = (text: string) => ({ record, text, isError: true })

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(UNKNOWN)
  }

  const call = input as Record<string, unknown>
  const current = activePlan(record)

  try {
    if (call.action === 'start') {
      const started = startPlan(
        record,
        {
          goal: call.goal as string,
          ...(typeof call.finish === 'string' ? { finish: call.finish } : {}),
          steps: list<StartInput['steps'][number]>(call.steps, 'steps') ?? [],
        },
        now,
      )
      const plan = activePlan(started.record)!
      const closed = started.closed
        ? `Прежний план «${started.closed.goal}» закрыт как ${started.closed.status}. `
        : ''

      return { record: awake(started.record), text: `${closed}План заведён. ${compact(plan)}`, isError: false }
    }

    if (call.action === 'update') {
      if (!current) {
        return fail(NO_PLAN)
      }

      const done = refs(call.done, 'done')
      const drop = refs(call.drop, 'drop')
      const add = list<NonNullable<UpdateInput['add']>[number]>(call.add, 'add')
      const plan = updatePlan(
        current,
        {
          ...(done ? { done } : {}),
          ...(drop ? { drop } : {}),
          ...(add ? { add } : {}),
          ...(call.active === undefined || call.active === null ? {} : { active: String(call.active) }),
          ...(typeof call.finish === 'string' ? { finish: call.finish } : {}),
          ...(typeof call.goal === 'string' ? { goal: call.goal } : {}),
        },
        now,
      )
      const left = plan.steps.filter(step => step.status === 'pending' || step.status === 'active')
      const last = left.length === 1 ? ' · остался один шаг: отметь его до итогового ответа' : ''

      return { record: awake(replace(record, plan)), text: compact(plan) + last, isError: false }
    }

    if (call.action === 'close') {
      if (!current) {
        return fail(NO_PLAN)
      }

      if (call.outcome !== 'done' && call.outcome !== 'abandoned') {
        throw new PlanError('Укажи outcome: "done" или "abandoned".')
      }

      const closed = closePlan(current, call.outcome, now)
      const dropped = closed.dropped.length > 0 ? ` Отброшены шаги: ${closed.dropped.join('; ')}.` : ''

      return {
        record: awake(replace(record, closed.plan)),
        text: `План закрыт: ${call.outcome}.${dropped}`,
        isError: false,
      }
    }
  } catch (error) {
    if (!(error instanceof PlanError)) {
      throw error
    }

    return fail(error.message + (current ? ' Сейчас: ' + compact(current) : ''))
  }

  return fail(UNKNOWN)
}
