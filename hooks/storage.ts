// Where plans live between sessions. The rest of the mod sees records and
// marks, never keys: the backing store can change without touching callers.

import { closePlan } from './plan'
import type { SessionRecord } from './plan'

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

const asRecord = (value: unknown, sessionId?: string): SessionRecord | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const record = value as Partial<SessionRecord>

  if (record.v !== 1 || typeof record.sessionId !== 'string' || !Array.isArray(record.plans)) {
    return undefined
  }

  if (sessionId !== undefined && record.sessionId !== sessionId) {
    return undefined
  }

  return record as SessionRecord
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
