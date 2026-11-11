// Where plans live between sessions. The rest of the mod sees records and
// marks, never keys: the backing store can change without touching callers.

import { closePlan } from './plan'
import type { Plan, SessionRecord, Step } from './plan'

/** The shape of `$.store`. */
export type Kv = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

const RECORD = 's:'
const DROP = 'drop:'
const PRUNED_AT = 'meta:prunedAt'
const PANE_CLOSED = 'pref:paneClosed'
const DAY = 24 * 60 * 60 * 1000
const KEEP_DAYS = 365

export const emptyRecord = (sessionId: string, project: string): SessionRecord => ({
  v: 1,
  sessionId,
  project,
  plans: [],
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const isMaybeText = (value: unknown): boolean => value === undefined || isText(value)

const STEP_STATUS = new Set(['pending', 'active', 'done', 'dropped'])
const PLAN_STATUS = new Set(['active', 'done', 'abandoned'])

const isStep = (value: unknown): value is Step =>
  isObject(value) &&
  isText(value.id) &&
  isText(value.text) &&
  (value.weight === 1 || value.weight === 2 || value.weight === 3) &&
  STEP_STATUS.has(value.status as string)

/** A plan another version or another session wrote, checked field by field. */
export const asPlan = (value: unknown): Plan | undefined =>
  isObject(value) &&
  isText(value.id) &&
  isText(value.goal) &&
  isText(value.createdAt) &&
  isText(value.updatedAt) &&
  isMaybeText(value.finish) &&
  isMaybeText(value.closedAt) &&
  PLAN_STATUS.has(value.status as string) &&
  Array.isArray(value.steps) &&
  value.steps.every(isStep)
    ? (value as Plan)
    : undefined

// A broken plan costs itself alone: the record keeps the plans that read.
const asRecord = (value: unknown, sessionId?: string): SessionRecord | undefined => {
  if (!isObject(value)) {
    return undefined
  }

  if (
    value.v !== 1 ||
    !isText(value.sessionId) ||
    !isText(value.project) ||
    !Array.isArray(value.plans)
  ) {
    return undefined
  }

  if (sessionId !== undefined && value.sessionId !== sessionId) {
    return undefined
  }

  const plans = value.plans.map(asPlan).filter((plan): plan is Plan => plan !== undefined)

  return { ...(value as SessionRecord), plans }
}

export const loadRecord = async (kv: Kv, sessionId: string): Promise<SessionRecord | undefined> =>
  asRecord(await kv.get(RECORD + sessionId), sessionId)

/** Resolves `false` when the store refused the write; never rejects. */
export const saveRecord = async (kv: Kv, record: SessionRecord): Promise<boolean> => {
  try {
    await kv.set(RECORD + record.sessionId, record)

    return true
  } catch {
    return false
  }
}

/**
 * Every session's record, the drop marks laid over them: a marked plan reads
 * as abandoned, its date kept. The marks stay for their owners to apply.
 */
export const loadAll = async (kv: Kv): Promise<SessionRecord[]> => {
  const keys = await kv.keys()
  const marks = new Set(keys.filter(key => key.startsWith(DROP)))
  const records: SessionRecord[] = []

  for (const key of keys.filter(one => one.startsWith(RECORD))) {
    const record = asRecord(await kv.get(key))

    if (!record) {
      continue
    }

    const plans = record.plans.map(plan =>
      plan.status === 'active' && marks.has(DROP + record.sessionId + ':' + plan.id)
        ? { ...plan, status: 'abandoned' as const }
        : plan,
    )
    records.push({ ...record, plans })
  }

  return records
}

/** Asks the owning session to abandon one of its plans; it applies the mark itself. */
export const markDropped = async (kv: Kv, sessionId: string, planId: string): Promise<void> => {
  await kv.set(DROP + sessionId + ':' + planId, true)
}

/** Applies the marks left for this session's plans and removes them. */
export const applyDrops = async (
  kv: Kv,
  record: SessionRecord,
  now: string,
): Promise<SessionRecord> => {
  const prefix = DROP + record.sessionId + ':'
  const marks = (await kv.keys()).filter(key => key.startsWith(prefix))

  if (marks.length === 0) {
    return record
  }

  const ids = marks.map(key => key.slice(prefix.length))
  const plans = record.plans.map(plan =>
    plan.status === 'active' && ids.includes(plan.id)
      ? closePlan(plan, 'abandoned', now).plan
      : plan,
  )

  for (const key of marks) {
    await kv.delete(key)
  }

  return { ...record, plans }
}

const lastTouched = (record: SessionRecord): number | undefined => {
  const times = record.plans.map(plan => Date.parse(plan.updatedAt)).filter(Number.isFinite)

  if (times.length > 0) {
    return Math.max(...times)
  }

  const ended = record.endedAt === undefined ? NaN : Date.parse(record.endedAt)

  return Number.isFinite(ended) ? ended : undefined
}

/** Drops records untouched for a year, whatever their plans' status. At most once a day. */
export const prune = async (kv: Kv, now: string): Promise<number> => {
  const at = Date.parse(now)
  const prunedAt = await kv.get(PRUNED_AT)

  if (typeof prunedAt === 'string' && at - Date.parse(prunedAt) < DAY) {
    return 0
  }

  const keys = await kv.keys()
  let removed = 0

  for (const key of keys.filter(one => one.startsWith(RECORD))) {
    const record = asRecord(await kv.get(key))
    const touched = record && lastTouched(record)

    if (!record || touched === undefined || at - touched <= KEEP_DAYS * DAY) {
      continue
    }

    await kv.delete(key)
    removed += 1

    for (const mark of keys.filter(one => one.startsWith(DROP + record.sessionId + ':'))) {
      await kv.delete(mark)
    }
  }

  try {
    await kv.set(PRUNED_AT, now)
  } catch {
    // A full store still got pruned; the next session tries again.
  }

  return removed
}

export const getPaneClosed = async (kv: Kv): Promise<boolean> =>
  (await kv.get(PANE_CLOSED)) === true

export const setPaneClosed = async (kv: Kv, closed: boolean): Promise<void> => {
  try {
    await (closed ? kv.set(PANE_CLOSED, true) : kv.delete(PANE_CLOSED))
  } catch {
    // The preference is a convenience: losing it reopens the pane, nothing more.
  }
}
