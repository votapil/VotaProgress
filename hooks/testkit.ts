// Fixtures shared by the tests. Not loaded by the mod.
import type { Plan, SessionRecord, Step } from './plan'

export const T0 = '2026-11-10T10:00:00.000Z'
export const T1 = '2026-11-10T11:00:00.000Z'
export const T2 = '2026-11-10T12:00:00.000Z'

export const step = (
  id: string,
  weight: 1 | 2 | 3,
  status: Step['status'],
  text = 'шаг ' + id,
): Step => ({ id, text, weight, status })

export const plan = (steps: Step[], finish: string | null = 'готово', goal = 'Мод progress'): Plan => ({
  id: 'p1',
  goal,
  ...(finish === null ? {} : { finish }),
  steps,
  status: 'active',
  createdAt: T0,
  updatedAt: T0,
})

export const EMPTY: SessionRecord = { v: 1, sessionId: 'a', project: '/home/u/Demo', plans: [] }

/** The message of the error `run` throws, or `null` when it returns. */
export const fails = (run: () => unknown): string | null => {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return null
}
