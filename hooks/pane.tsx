// The pane's «this chat» view: the project, the plan in hand and what came
// before it in this session. Draws from values, reads nothing itself.

import type { ElementTable, RenderSurface } from 'claude-code'

import { activePlan, activeStep, clip, percent, projectName, windowSteps } from './plan'
import type { Plan, SessionRecord, Step } from './plan'

export const PANE = 'votaprogress'
export const PANE_TITLE = 'Прогресс'

const BAR = 20
const HISTORY = 3
/** Marks a step of weight 3. */
const HEAVY = '◆'

export type ChatView = {
  record: SessionRecord | null
  project: string
  /** Rows and columns the pane's body has. */
  rows: number
  columns: number
  isWaiting: boolean
  storeFailed: boolean
}

const bar = (value: number): string => {
  const filled = Math.round((value / 100) * BAR)

  return '█'.repeat(filled) + '░'.repeat(BAR - filled)
}

const plural = (count: number): string => {
  const tail = count % 100
  const last = count % 10

  if (tail >= 11 && tail <= 14) {
    return 'шагов'
  }

  return last === 1 ? 'шаг' : last >= 2 && last <= 4 ? 'шага' : 'шагов'
}

export const renderChat = <S extends RenderSurface>(table: ElementTable<S>, view: ChatView) => {
  const { Box, Text } = table
  const plan = view.record ? activePlan(view.record) : undefined
  const earlier = (view.record?.plans ?? [])
    .filter(one => one.status !== 'active')
    .slice(-HISTORY)
    .reverse()
  const value = plan ? percent(plan) : null
  const current = plan ? activeStep(plan) : undefined
  const headline = value === null ? '∞' : value + '%'
  const fixed =
    2 +
    (value === null ? 0 : 1) +
    (plan?.finish === undefined ? 0 : 1) +
    1 +
    (earlier.length > 0 ? earlier.length + 2 : 0) +
    (view.storeFailed ? 2 : 0)
  const shown = plan ? windowSteps(plan.steps, Math.max(1, view.rows - fixed)) : undefined

  // The left text is cut here, to the cells the tag on the right leaves: left
  // to the surface, a long text pushes the tag onto a second line.
  const row = (left: string, right?: string, isDim = false) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor={isDim}>
        {clip(left, Math.max(1, view.columns - (right === undefined ? 0 : [...right].length + 1)))}
      </Text>
      {right === undefined ? null : <Text dimColor>{right}</Text>}
    </Box>
  )
  const stepRow = (step: Step) =>
    row(
      (step.status === 'done' ? '✓ ' : step.status === 'active' ? '◐ ' : '○ ') + step.text,
      // The circle already says which step is in hand; the tag is for what it
      // cannot say: the step waits on the person, or it is a heavy one.
      step.id === current?.id && view.isWaiting
        ? 'ждёт ответа'
        : step.weight === 3 && step.status !== 'done'
          ? HEAVY
          : undefined,
      step.status !== 'active',
    )
  const earlierRow = (one: Plan) =>
    row(
      (one.status === 'done' ? '✓ ' : '× ') + one.goal,
      one.status === 'done' ? '100%' : 'брошен',
      true,
    )

  return (
    <Box flexDirection="column">
      <Text bold>{view.project}</Text>
      {!plan && <Text dimColor>плана нет</Text>}
      {plan && (
        <Box flexDirection="row" justifyContent="space-between">
          <Text>{clip(plan.goal, Math.max(1, view.columns - [...headline].length - 1))}</Text>
          <Text bold>{headline}</Text>
        </Box>
      )}
      {plan && value !== null && (
        <Box flexDirection="row" gap={1}>
          <Text>{bar(value)}</Text>
          {plan.lastChange && (
            <Text dimColor>
              {'+' + plan.lastChange.added + ' ' + plural(plan.lastChange.added) + ', было ' + plan.lastChange.percentBefore + '%'}
            </Text>
          )}
        </Box>
      )}
      {plan?.finish !== undefined && (
        <Text dimColor>{clip('финал: ' + plan.finish, view.columns)}</Text>
      )}
      {shown && (
        <Box flexDirection="column" marginTop={1}>
          {shown.doneCount > 0 && <Text dimColor>{'✓ ' + shown.doneCount + ' сделано'}</Text>}
          {shown.shown.map(stepRow)}
          {shown.more > 0 && <Text dimColor>{'… ещё ' + shown.more}</Text>}
        </Box>
      )}
      {earlier.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Раньше в этом чате</Text>
          {earlier.map(earlierRow)}
        </Box>
      )}
      {view.storeFailed && (
        <Box marginTop={1}>
          <Text color="warning">хранилище заполнено, планы не сохраняются</Text>
        </Box>
      )}
    </Box>
  )
}

export const projectOf = (record: SessionRecord | null, root: string): string =>
  projectName(record?.project ?? root)
