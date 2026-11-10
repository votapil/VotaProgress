// The plan model and everything computed from it. Pure: no engine, no clock.

export type StepStatus = 'pending' | 'active' | 'done' | 'dropped'

export type Step = {
  id: string
  text: string
  weight: 1 | 2 | 3
  status: StepStatus
}

export type Plan = {
  id: string
  goal: string
  finish?: string
  steps: Step[]
  status: 'active' | 'done' | 'abandoned'
  createdAt: string
  updatedAt: string
  closedAt?: string
  lastChange?: { added: number; percentBefore: number }
}

export type SessionRecord = {
  v: 1
  sessionId: string
  project: string
  plans: Plan[]
  endedAt?: string
  endReason?: string
}

const MAX_TEXT = 120

export const cleanText = (text: string): string =>
  [...text.replace(/\s+/g, ' ').trim()].slice(0, MAX_TEXT).join('')

const live = (plan: Plan): Step[] => plan.steps.filter(step => step.status !== 'dropped')

export const percent = (plan: Plan): number | null => {
  const steps = live(plan)

  if (plan.finish === undefined || steps.length === 0) {
    return null
  }

  const total = steps.reduce((sum, step) => sum + step.weight, 0)
  const done = steps
    .filter(step => step.status === 'done')
    .reduce((sum, step) => sum + step.weight, 0)

  return Math.round((100 * done) / total)
}

export const counts = (plan: Plan): { done: number; total: number } => {
  const steps = live(plan)

  return { done: steps.filter(step => step.status === 'done').length, total: steps.length }
}

export const activePlan = (record: SessionRecord): Plan | undefined =>
  record.plans.find(plan => plan.status === 'active')

export const activeStep = (plan: Plan): Step | undefined =>
  plan.steps.find(step => step.status === 'active')

const MARK: Record<Exclude<StepStatus, 'dropped'>, string> = {
  done: '✓',
  active: '◐',
  pending: '○',
}

/** The plan as the model reads it back: `45% · 1✓ 2✓ 3◐ тесты · 4○ 5○`. */
export const compact = (plan: Plan): string => {
  const steps = live(plan)
  const value = percent(plan)
  const word = (step: Step): string =>
    step.id +
    MARK[step.status as Exclude<StepStatus, 'dropped'>] +
    (step.status === 'active' ? ' ' + step.text : '')
  const cut = steps.findIndex(step => step.status === 'active') + 1
  const groups = cut === 0 ? [steps] : [steps.slice(0, cut), steps.slice(cut)]

  return [
    value === null ? '∞' : value + '%',
    ...groups.filter(group => group.length > 0).map(group => group.map(word).join(' ')),
  ].join(' · ')
}

// ---------------------------------------------------------------- transitions

/** A refusal the model can act on: its message is shown to the model as is. */
export class PlanError extends Error {}

export type StartInput = {
  goal: string
  finish?: string
  steps: { text: string; weight?: number }[]
}

export type UpdateInput = {
  done?: string[]
  active?: string
  add?: { text: string; weight?: number; after?: string }[]
  drop?: string[]
  finish?: string
}

const MAX_STEPS = 30

const weightOf = (weight: number | undefined): 1 | 2 | 3 => {
  if (weight === undefined) {
    return 1
  }

  if (weight !== 1 && weight !== 2 && weight !== 3) {
    throw new PlanError(`Вес шага - 1, 2 или 3, а пришло ${String(weight)}.`)
  }

  return weight
}

const textOf = (text: unknown): string => {
  const clean = typeof text === 'string' ? cleanText(text) : ''

  if (clean === '') {
    throw new PlanError('У шага пустой текст.')
  }

  return clean
}

const allLiveDone = (plan: Plan): boolean => {
  const steps = live(plan)

  return steps.length > 0 && steps.every(step => step.status === 'done')
}

export const closePlan = (
  plan: Plan,
  outcome: 'done' | 'abandoned',
  now: string,
): { plan: Plan; dropped: string[] } => {
  const dropped: string[] = []
  const steps =
    outcome === 'abandoned'
      ? plan.steps
      : plan.steps.map((step): Step => {
          if (step.status === 'active') {
            return { ...step, status: 'done' }
          }

          if (step.status === 'pending') {
            dropped.push(step.text)

            return { ...step, status: 'dropped' }
          }

          return step
        })
  const { lastChange: _lastChange, ...rest } = plan

  return { plan: { ...rest, steps, status: outcome, closedAt: now, updatedAt: now }, dropped }
}

export const startPlan = (
  record: SessionRecord,
  input: StartInput,
  now: string,
): { record: SessionRecord; closed?: { goal: string; status: 'done' | 'abandoned' } } => {
  const goal = typeof input.goal === 'string' ? cleanText(input.goal) : ''

  if (goal === '') {
    throw new PlanError('У плана пустая цель (goal).')
  }

  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
    throw new PlanError(`В плане должно быть от 1 до ${MAX_STEPS} шагов (steps).`)
  }

  const steps = input.steps.map(
    (step, index): Step => ({
      id: String(index + 1),
      text: textOf(step?.text),
      weight: weightOf(step?.weight),
      status: index === 0 ? 'active' : 'pending',
    }),
  )
  const finish = typeof input.finish === 'string' ? cleanText(input.finish) : ''
  let closed: { goal: string; status: 'done' | 'abandoned' } | undefined
  const plans = record.plans.map(plan => {
    if (plan.status !== 'active') {
      return plan
    }

    const status = allLiveDone(plan) ? 'done' : 'abandoned'
    closed = { goal: plan.goal, status }

    return closePlan(plan, status, now).plan
  })
  const created: Plan = {
    id: 'p' + (record.plans.length + 1),
    goal,
    ...(finish === '' ? {} : { finish }),
    steps,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }

  return { record: { ...record, plans: [...plans, created] }, ...(closed ? { closed } : {}) }
}

export const updatePlan = (plan: Plan, input: UpdateInput, now: string): Plan => {
  let steps = plan.steps.map(step => ({ ...step }))
  const find = (ref: string): Step => {
    const wanted = String(ref).trim()
    const found =
      steps.find(step => step.id === wanted) ??
      steps.find(step => step.status !== 'dropped' && step.text === cleanText(wanted))

    if (!found) {
      const ids = steps.filter(step => step.status !== 'dropped').map(step => step.id)

      throw new PlanError(`В плане нет шага ${wanted}. Есть шаги: ${ids.join(', ')}.`)
    }

    return found
  }
  const before = percent(plan)
  const added = input.add ?? []

  for (const one of added) {
    const created: Step = {
      id: String(Math.max(0, ...steps.map(step => Number(step.id))) + 1),
      text: textOf(one?.text),
      weight: weightOf(one?.weight),
      status: 'pending',
    }

    if (one.after === undefined) {
      steps.push(created)
    } else {
      const at = steps.indexOf(find(one.after))
      steps = [...steps.slice(0, at + 1), created, ...steps.slice(at + 1)]
    }
  }

  if (live({ ...plan, steps }).length > MAX_STEPS) {
    throw new PlanError(`В плане не может быть больше ${MAX_STEPS} шагов.`)
  }

  const dropIds = (input.drop ?? []).map(ref => find(ref).id)
  const doneIds = (input.done ?? []).map(ref => find(ref).id)
  const clash = doneIds.find(id => dropIds.includes(id))

  if (clash !== undefined) {
    throw new PlanError(`Шаг ${clash} указан и в done, и в drop. Выбери одно.`)
  }

  for (const step of steps) {
    if (dropIds.includes(step.id)) {
      step.status = 'dropped'
    } else if (doneIds.includes(step.id)) {
      step.status = 'done'
    }
  }

  if (input.active !== undefined) {
    const target = find(input.active)

    if (target.status === 'done' || target.status === 'dropped') {
      throw new PlanError(`Шаг ${target.id} уже закрыт, активным его сделать нельзя.`)
    }

    for (const step of steps) {
      if (step.status === 'active') {
        step.status = 'pending'
      }
    }

    target.status = 'active'
  } else if (!steps.some(step => step.status === 'active')) {
    const next = steps.find(step => step.status === 'pending')

    if (next) {
      next.status = 'active'
    }
  }

  const { lastChange: _lastChange, finish: oldFinish, ...rest } = plan
  const finish = input.finish === undefined ? oldFinish : cleanText(String(input.finish))

  return {
    ...rest,
    ...(finish === undefined || finish === '' ? {} : { finish }),
    steps,
    updatedAt: now,
    ...(added.length > 0 ? { lastChange: { added: added.length, percentBefore: before ?? 0 } } : {}),
  }
}

export const shouldAutoClose = (plan: Plan): boolean =>
  plan.status === 'active' && plan.finish !== undefined && allLiveDone(plan)

// ------------------------------------------------------------------- display

/**
 * Which steps fit in `rows` lines: done steps fold into one counter line, then
 * the active step and what follows; what does not fit is counted in `more`.
 */
export const windowSteps = (
  steps: Step[],
  rows: number,
): { doneCount: number; shown: Step[]; more: number } => {
  const visible = steps.filter(step => step.status !== 'dropped')

  if (visible.length <= rows) {
    return { doneCount: 0, shown: visible, more: 0 }
  }

  const rest = visible.filter(step => step.status !== 'done')
  const done = visible.length - rest.length

  if (rows <= 1) {
    return { doneCount: 0, shown: rest.slice(0, 1), more: 0 }
  }

  const doneCount = done > 0 ? done : 0
  const room = rows - (doneCount > 0 ? 1 : 0)

  if (rest.length <= room) {
    return { doneCount, shown: rest, more: 0 }
  }

  const shown = rest.slice(0, Math.max(1, room - 1))

  return { doneCount, shown, more: rest.length - shown.length }
}

export const projectName = (root: string): string =>
  root.split('/').filter(part => part !== '').pop() ?? root

const clip = (text: string, max: number): string => {
  const chars = [...text]

  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

/** One line under the prompt: project, goal, progress and the step in hand. */
export const statusLine = (
  project: string,
  plan: Plan | undefined,
  isWaiting: boolean,
): string | undefined => {
  if (!plan) {
    return undefined
  }

  const value = percent(plan)
  const { done, total } = counts(plan)
  const current = activeStep(plan)

  return [
    project,
    clip(plan.goal, 40),
    value === null ? '∞' : value + '%',
    value === null ? 'сделано ' + done : done + '/' + total,
    ...(current ? [(isWaiting ? 'ждёт ответа: ' : 'сейчас: ') + clip(current.text, 40)] : []),
  ].join(' · ')
}
