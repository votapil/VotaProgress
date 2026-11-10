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
