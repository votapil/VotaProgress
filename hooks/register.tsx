// API shapes this module relies on (claude-code.d.ts, build 2.1.322):
// - a `tool.call` hook serving the mod's own tool answers `{ result }` (the
//   text the model reads) or `{ deny }` (the model reads it as an error);
// - `session.start` answers `{ cwd }` from `next(e)`; it fires once per
//   process and never after /clear, so the session is checked on every call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { renderOverview } from './overview'
import type { OverviewActions } from './overview'
import { PANE, PANE_TITLE, projectOf, renderChat } from './pane'
import { activePlan, autoCloseOutcome, closePlan, projectName, statusLine } from './plan'
import type { SessionRecord } from './plan'
import { PAGE, folders, nextPeriod, nextStatus, withOwn } from './query'
import type { Row } from './query'
import { NUDGE, RULE, replanText } from './rule'
import {
  applyDrops,
  emptyRecord,
  getPaneClosed,
  loadAll,
  loadRecord,
  markDropped,
  prune,
  saveRecord,
  setPaneClosed,
} from './storage'
import type { Kv } from './storage'
import { handle, toolSpec } from './tool'

const session = atom(
  { plugin: 'votaprogress', key: 'session' } as const,
  { owner: null, record: null },
  { shape: 'session-1' },
)
const flags = atom({ plugin: 'votaprogress', key: 'flags' } as const, {
  storeFailed: false,
  replanPending: false,
})

const pane = atom(
  { plugin: 'votaprogress', key: 'pane' } as const,
  {
    view: 'chat',
    query: '',
    status: 'open',
    period: '30d',
    folders: {},
    openPlan: null,
    more: {},
    rev: 0,
  },
  { shape: 'pane-3' },
)

// A third of a 144-column terminal, the narrowest one a pane opens in unasked.
// The engine caps it at 45% and a width the person set by hand wins.
const PANE_COLUMNS = 48
const MIN_COLUMNS = 24

/** A third of the terminal the command ran in, between 24 and 48 columns. */
const thirdOf = (columns: number | undefined): number =>
  columns === undefined
    ? PANE_COLUMNS
    : Math.max(MIN_COLUMNS, Math.min(PANE_COLUMNS, Math.floor(columns / 3)))

const NOT_COPIED: Record<'no-surface' | 'no-clipboard' | 'refused', string> = {
  'no-surface': 'некуда копировать',
  'no-clipboard': 'нет буфера обмена',
  refused: 'отказано',
}

// The overview's read of every session's record. It lives in the module, not
// in `$.state`: a reload loses it and `session.start` reads it again; the
// state holds only a revision so the pane redraws.
let snapshot: SessionRecord[] | null = null

type $ = EngineInterface

// The engine wants every call spelled `$.noun.method(...)`: the store is
// handed on as closures, never as `$.store` itself.
const kv = ($: $): Kv => ({
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  delete: key => $.store.delete(key),
  keys: () => $.store.keys(),
})

const nowIso = async ($: $): Promise<string> => new Date(await $.clock.now()).toISOString()

const raise = async ($: $, id: string): Promise<SessionRecord> => {
  const stored = await loadRecord(kv($), id)

  if (!stored) {
    return emptyRecord(id, await $.session.root())
  }

  const record = await applyDrops(kv($), stored, await nowIso($))

  if (record !== stored) {
    await saveRecord(kv($), record)
  }

  return record
}

/** The record of the session the process runs now, raised from the store when it changed. */
export const ensureSession = async ($: $): Promise<SessionRecord> => {
  const id = await $.session.id()
  const held = await read($, session)

  if (held.owner === id && held.record) {
    // A plan dropped from another session's overview closes before the next
    // write; a store that cannot be read leaves the record as it is.
    const marked = await (async () =>
      applyDrops(kv($), held.record!, await nowIso($)))().catch(() => held.record!)

    if (marked !== held.record) {
      await commit($, marked)
    }

    return marked
  }

  // A store that cannot be read costs the history, not the tool: the session
  // goes on with an empty record and the person is told plans are not kept.
  const record = await raise($, id).catch(async () => {
    await update($, flags, held => ({ ...held, storeFailed: true }))

    return emptyRecord(id, await $.session.root())
  })

  await update($, session, () => ({ owner: id, record }))

  return record
}

/** Keeps a changed record: the state first, then the store, which may refuse. */
export const commit = async ($: $, record: SessionRecord): Promise<void> => {
  await update($, session, () => ({ owner: record.sessionId, record }))
  const isSaved = await saveRecord(kv($), record)
  await update($, flags, held => ({ ...held, storeFailed: !isSaved }))
  await refreshStatus($)
}

/**
 * The line under the prompt stands in for the pane while the pane is not drawn.
 * The engine is asked each time: it draws a waiting pane when the terminal
 * widens and drops a broken one, and tells the mod of neither.
 */
export const refreshStatus = async ($: $): Promise<void> => {
  const isPlaced = (await $.ui.panes()).some(one => one.id === PANE && one.isPlaced)
  const { record } = await read($, session)
  const plan = record ? activePlan(record) : undefined

  $.ui.status(isPlaced || !record ? undefined : statusLine(projectName(record.project), plan))
}

const openPane = async ($: $, columns = PANE_COLUMNS, focus = false): Promise<boolean> => {
  const opened = await $.ui.open({
    id: PANE,
    title: PANE_TITLE,
    columns,
    ...(focus ? { focus: true as const } : {}),
  })
  await refreshStatus($)

  return opened.isPlaced
}

/** Rereads every record for the overview; a store that cannot be read keeps the last read. */
const reload = async ($: $): Promise<void> => {
  snapshot = await loadAll(kv($)).catch(() => snapshot ?? [])
  await update($, pane, held => ({ ...held, rev: held.rev + 1 }))
}

const showAll = async ($: $): Promise<void> => {
  await update($, pane, held => ({ ...held, view: 'all' as const }))
  await reload($)
}

/** A press runs its work in the background; a failure costs the press, not the pane. */
const quietly = (work: Promise<unknown>): void => {
  work.catch(() => undefined)
}

const overviewActions = ($: $): OverviewActions => ({
  chat: () => quietly(update($, pane, held => ({ ...held, view: 'chat' as const }))),
  refresh: () => quietly(reload($)),
  folder: project =>
    quietly(
      (async () => {
        const current = (await read($, session)).record?.project ?? (await $.session.root())
        await update($, pane, held => {
          const isOpen = held.folders[project] ?? project === current

          return { ...held, folders: { ...held.folders, [project]: !isOpen } }
        })
      })(),
    ),
  plan: key =>
    quietly(update($, pane, held => ({ ...held, openPlan: held.openPlan === key ? null : key }))),
  more: project =>
    quietly(
      update($, pane, held => ({
        ...held,
        more: { ...held.more, [project]: (held.more[project] ?? 0) + PAGE },
      })),
    ),
  copy: (text, surface) =>
    quietly(
      (async () => {
        const out = await $.ui.copy({ text, surface })
        $.ui.toast(
          out.isCopied
            ? 'Команда скопирована'
            : 'Не скопировано: ' + NOT_COPIED[out.reason] + '. Выдели команду вручную',
        )
      })(),
    ),
  drop: (row: Row) =>
    quietly(
      (async () => {
        // Only another session's unfinished plan: this chat's plan is closed by the model.
        if (row.sessionId === (await read($, session)).owner || row.plan.status !== 'active') {
          return
        }

        const isMarked = await markDropped(kv($), row.sessionId, row.plan.id).then(
          () => true,
          () => false,
        )
        $.ui.toast(isMarked ? 'План выброшен' : 'Не выброшено: хранилище не приняло отметку')
        await update($, pane, held => ({ ...held, openPlan: null }))
        await reload($)
      })(),
    ),
  // A new search or filter starts the list over: no plan open, first pages only.
  search: text =>
    quietly(update($, pane, held => (held.query === text ? held : { ...held, query: text, openPlan: null, more: {} }))),
  status: () =>
    quietly(update($, pane, held => ({ ...held, status: nextStatus(held.status), openPlan: null, more: {} }))),
  period: () =>
    quietly(update($, pane, held => ({ ...held, period: nextPeriod(held.period), openPlan: null, more: {} }))),
  reset: () =>
    quietly(
      update($, pane, held => ({
        ...held,
        query: '',
        status: 'open' as const,
        period: '30d' as const,
        openPlan: null,
        more: {},
      })),
    ),
})

const OWN = 'mcp__votaprogress__progress'
const COMPACTIONS = 20

/** What a call of the mod's own tool carries that the hook reads. */
type OwnCall = { agentId?: string; action?: unknown }
const EDITING = new Set(['Edit', 'Write', 'NotebookEdit'])
const NUDGE_AT = 3

/** The plan the model is owed after a compaction, once; `undefined` when none is. */
const takeReplan = async ($: $): Promise<string | undefined> => {
  if (!(await read($, flags)).replanPending) {
    return undefined
  }

  await update($, flags, held => ({ ...held, replanPending: false }))
  const plan = activePlan(await ensureSession($))

  return plan ? replanText(plan) : undefined
}

export const register: Register = on => {
  // This turn's file edits made without a plan, and whether the model was told.
  let edits = 0
  let isNudged = false

  on('session.start', async ($, e, next) => {
    await $.tool.register(toolSpec)
    await $.command.register({
      name: 'progress',
      description: 'Показать план задачи в панели; all - обзор всех проектов',
      argumentHint: '[all]',
    })
    await ensureSession($)
    await prune(kv($), await nowIso($))
    await refreshStatus($)

    // After a reload of the module the overview has no read of the store yet.
    if ((await read($, pane)).view === 'all') {
      await reload($)
    }

    return next(e)
  })

  // The generated tool types list other plugins' tools, never the mod's own:
  // the matcher and the call's input are typed here by hand.
  on('tool.call', { tool: 'mcp__votaprogress__progress' } as never, async ($: $, e: OwnCall) => {
    if (e.agentId !== undefined) {
      return { deny: 'план ведёт основная сессия' }
    }

    const record = await ensureSession($)
    const out = handle(record, e, await nowIso($))

    if (out.isError) {
      return { deny: out.text }
    }

    await commit($, out.record)

    // The first plan of a session brings the pane up, unless the person closed
    // it. The plan is kept by now: a pane that fails must not read as a failed call.
    if (e.action === 'start' && out.record.plans.length === 1) {
      await (async () => {
        if (!(await getPaneClosed(kv($)))) {
          await openPane($)
        }
      })().catch(() => undefined)
    }

    return { result: out.text }
  }).catch(() => ({ deny: 'VotaProgress: инструмент дал сбой, план не изменён.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!e.tools.includes(OWN)) {
      return composed
    }

    return {
      ...composed,
      sections: [...composed.sections, { id: 'votaprogress:rule', text: RULE, scope: 'session' }],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    edits = 0
    isNudged = false
    await ensureSession($)
    await refreshStatus($)
    const replan = await takeReplan($)

    return next(replan === undefined ? e : { ...e, context: [...(e.context ?? []), replan] })
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined || (e.tool as string) === OWN || ran.deny !== undefined) {
      return ran
    }

    const context: string[] = []

    if (EDITING.has(e.tool)) {
      edits += 1

      if (edits >= NUDGE_AT && !isNudged && !activePlan(await ensureSession($))) {
        isNudged = true
        context.push(NUDGE)
      }
    }

    const replan = await takeReplan($)

    if (replan !== undefined) {
      context.push(replan)
    }

    return context.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...context] }
  })

  on('session.compact', async ($, e, next) => {
    const out = await next(e)

    // Only a compaction that was installed in the main conversation: a
    // precompute installs nothing and a vetoed one changed nothing.
    if (e.agentId === undefined && e.trigger !== 'precompute' && out.skip === undefined) {
      await update($, flags, held => ({ ...held, replanPending: true }))

      // Marked only where there is a plan to stand above: a session without
      // plans keeps no record. A mark that fails costs the mark alone.
      await (async () => {
        const record = await ensureSession($)

        if (record.plans.length > 0) {
          const compactions = [...(record.compactions ?? []), await nowIso($)].slice(-COMPACTIONS)
          await commit($, { ...record, compactions })
        }
      })().catch(() => undefined)
    }

    return out
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const record = await ensureSession($)
      const plan = activePlan(record)
      const outcome = plan && autoCloseOutcome(plan)

      if (plan && outcome) {
        const closed = closePlan(plan, outcome, await nowIso($)).plan
        await commit($, {
          ...record,
          plans: record.plans.map(one => (one.id === closed.id ? closed : one)),
        })
      }
    }

    if (e.agentId === undefined) {
      await refreshStatus($)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refreshStatus($)
    }

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    await setPaneClosed(kv($), false)
    await ensureSession($)
    const isAll = e.args.trim() === 'all'

    if (isAll) {
      await showAll($)
    }

    const isPlaced = await openPane($, thirdOf(e.presentation?.columns), isAll)

    if (!isPlaced) {
      return { text: 'Панель не поместилась: план виден в строке под вводом.' }
    }

    return { text: isAll ? 'Обзор всех проектов открыт.' : 'Панель прогресса открыта.' }
  })

  on('ui.close', { id: 'votaprogress' }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await setPaneClosed(kv($), true)
    }

    const closed = await next(e)
    await refreshStatus($)

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: 'votaprogress' }, async ($, e) => {
    const { record } = await read($, session)
    const { storeFailed } = await read($, flags)
    const state = await read($, pane)
    const root = await $.session.root()

    if (state.view === 'all') {
      const now = await nowIso($)

      return renderOverview($.ui.resolve(e), {
        folders:
          snapshot === null
            ? null
            : folders(withOwn(snapshot, record), {
                current: record?.project ?? root,
                ownSession: record?.sessionId ?? '',
                now,
                query: state.query,
                status: state.status,
                period: state.period,
              }),
        state,
        columns: e.props.bodyColumns,
        now,
        on: overviewActions($),
      })
    }

    return renderChat($.ui.resolve(e), {
      record,
      project: projectOf(record, root),
      rows: e.props.scroll.bodyRows,
      columns: e.props.bodyColumns,
      storeFailed,
      onAll: () => quietly(showAll($)),
    })
  })

  on('session.end', async ($, e, next) => {
    const held = await read($, session)

    if (held.owner === e.sessionId && held.record && held.record.plans.length > 0) {
      await saveRecord(kv($), { ...held.record, endedAt: await nowIso($), endReason: e.reason })
    }

    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, session, () => ({ owner: null, record: null }))
      await update($, flags, held => ({ ...held, replanPending: false }))
      await refreshStatus($)
    }

    return next(e)
  })
}
