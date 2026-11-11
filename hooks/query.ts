// What the «all projects» view shows: every session's plans, grouped by the
// folder they were made in. Pure: no engine, no clock.

import type { PeriodFilter, StatusFilter } from '../types'
import type { Plan, SessionRecord } from './plan'

/** Plans a folder shows before its «ещё 30». */
export const PAGE = 30

const DAY = 24 * 60 * 60 * 1000
const STALE_DAYS = 30

/** One plan as the overview lists it. */
export type Row = {
  /** `sessionId:planId`, unique across sessions. */
  key: string
  sessionId: string
  project: string
  plan: Plan
  /** The plan belongs to the session the pane is drawn in. */
  isOwn: boolean
  /** Its session ended cleanly: the chat is closed. */
  isEnded: boolean
}

export type Folder = {
  project: string
  name: string
  isCurrent: boolean
  /** Unfinished plans among the rows. */
  unfinished: number
  /** Newest first. */
  rows: Row[]
}

export type Scope = {
  /** The folder the pane's session runs in. */
  current: string
  ownSession: string
  now: string
  query: string
  status: StatusFilter
  period: PeriodFilter
}

export const STATUS_LABEL: Record<StatusFilter, string> = {
  open: 'не закончено',
  all: 'всё',
  closed: 'закончено',
}

export const PERIOD_LABEL: Record<PeriodFilter, string> = {
  '7d': '7 дн',
  '30d': '30 дн',
  '6m': '6 мес',
  all: 'всё',
}

const STATUSES: StatusFilter[] = ['open', 'all', 'closed']
const PERIODS: PeriodFilter[] = ['7d', '30d', '6m', 'all']
const PERIOD_DAYS: Record<PeriodFilter, number> = { '7d': 7, '30d': 30, '6m': 182, all: Infinity }

const after = <T>(list: T[], value: T): T => list[(list.indexOf(value) + 1) % list.length]!

export const nextStatus = (status: StatusFilter): StatusFilter => after(STATUSES, status)

export const nextPeriod = (period: PeriodFilter): PeriodFilter => after(PERIODS, period)

const lower = (text: string): string => text.toLocaleLowerCase('ru')

/** The search: a piece of the goal or of a step still in the plan, any case. */
const matches = (plan: Plan, query: string): boolean => {
  const wanted = lower(query.trim())

  return (
    wanted === '' ||
    [plan.goal, ...plan.steps.filter(step => step.status !== 'dropped').map(step => step.text)].some(
      text => lower(text).includes(wanted),
    )
  )
}

const passesStatus = (plan: Plan, status: StatusFilter): boolean =>
  status === 'all' || (status === 'open') === (plan.status === 'active')

/** The records with the session's own one, fresher than the store's, in its place. */
export const withOwn = (records: SessionRecord[], own: SessionRecord | null): SessionRecord[] => {
  if (!own) {
    return records
  }

  return records.some(one => one.sessionId === own.sessionId)
    ? records.map(one => (one.sessionId === own.sessionId ? own : one))
    : [...records, own]
}

const parts = (path: string): string[] => path.split('/').filter(part => part !== '')

/** A folder's last part, or its last two where another folder ends the same. */
export const folderNames = (projects: string[]): Map<string, string> => {
  const last = (path: string): string => parts(path).at(-1) ?? path
  const seen = new Map<string, number>()

  for (const path of new Set(projects)) {
    seen.set(last(path), (seen.get(last(path)) ?? 0) + 1)
  }

  return new Map(
    projects.map(path => [
      path,
      (seen.get(last(path)) ?? 0) > 1 ? parts(path).slice(-2).join('/') || path : last(path),
    ]),
  )
}

const time = (iso: string): number => {
  const at = Date.parse(iso)

  return Number.isFinite(at) ? at : 0
}

/**
 * The overview's folders: the current one first, the rest by their newest
 * plan; only plans the search and the filters let through, only folders
 * left with any.
 */
export const folders = (records: SessionRecord[], scope: Scope): Folder[] => {
  const since = time(scope.now) - PERIOD_DAYS[scope.period] * DAY
  const rows: Row[] = records.flatMap(record =>
    record.plans
      .filter(plan => time(plan.updatedAt) >= since && matches(plan, scope.query))
      .map(plan => ({
        key: record.sessionId + ':' + plan.id,
        sessionId: record.sessionId,
        project: record.project,
        plan,
        isOwn: record.sessionId === scope.ownSession,
        isEnded: record.endedAt !== undefined,
      })),
  )
  const byProject = new Map<string, Row[]>()

  for (const row of rows) {
    byProject.set(row.project, [...(byProject.get(row.project) ?? []), row])
  }

  const names = folderNames([...byProject.keys()])
  const newest = (folder: Folder): number => time(folder.rows[0]?.plan.updatedAt ?? '')

  // The count of unfinished plans stays whatever the status filter: it is
  // what is left to do in the folder over that period.
  return [...byProject.entries()]
    .map(([project, list]) => ({
      project,
      name: names.get(project) ?? project,
      isCurrent: project === scope.current,
      unfinished: list.filter(row => row.plan.status === 'active').length,
      rows: list
        .filter(row => passesStatus(row.plan, scope.status))
        .sort((a, b) => time(b.plan.updatedAt) - time(a.plan.updatedAt)),
    }))
    .filter(folder => folder.rows.length > 0)
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || newest(b) - newest(a))
}

/** The line that brings the chat back, for bash and zsh. */
export const resumeCommand = (project: string, sessionId: string): string =>
  `cd '${project.replaceAll("'", "'\\''")}' && claude --resume ${sessionId}`

const two = (n: number): string => String(n).padStart(2, '0')

/** `дд.мм`, or `дд.мм.гг` for another year, in local time. */
export const shortDate = (iso: string, now: string): string => {
  const at = new Date(iso)
  const day = two(at.getDate()) + '.' + two(at.getMonth() + 1)

  return at.getFullYear() === new Date(now).getFullYear()
    ? day
    : day + '.' + two(at.getFullYear() % 100)
}

/** An unfinished plan nobody touched for over 30 days: drawn dim. */
export const isStale = (plan: Plan, now: string): boolean =>
  plan.status === 'active' && time(now) - time(plan.updatedAt) > STALE_DAYS * DAY

/** What the row's second line says after the date. */
export const rowNote = (row: Row): string | undefined => {
  if (row.plan.status === 'done') {
    return 'сделан'
  }

  if (row.plan.status === 'abandoned') {
    return 'брошен'
  }

  if (row.isOwn) {
    return 'этот чат'
  }

  return row.isEnded ? 'чат закрыт' : undefined
}
