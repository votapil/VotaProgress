// API shapes this module relies on (claude-code.d.ts, build 2.1.322):
// - a `tool.call` hook serving the mod's own tool answers `{ result }` (the
//   text the model reads) or `{ deny }` (the model reads it as an error);
// - `session.start` answers `{ cwd }` from `next(e)`; it fires once per
//   process and never after /clear, so the session is checked on every call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { PANE, PANE_TITLE, projectOf, renderChat } from './pane'
import { activePlan, autoCloseOutcome, closePlan, projectName, statusLine } from './plan'
import type { SessionRecord } from './plan'
import { NUDGE, RULE, replanText } from './rule'
import {
  applyDrops,
  emptyRecord,
  getPaneClosed,
  loadRecord,
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

// A third of a 144-column terminal, the narrowest one a pane opens in unasked.
// The engine caps it at 45% and a width the person set by hand wins.
const PANE_COLUMNS = 48

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
    return held.record
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

const openPane = async ($: $): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })
  await refreshStatus($)

  return opened.isPlaced
}

const OWN = 'mcp__votaprogress__progress'

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
    await $.command.register({ name: 'progress', description: 'Показать план задачи в панели' })
    await ensureSession($)
    await prune(kv($), await nowIso($))
    await refreshStatus($)

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

  on('command.run', { command: 'progress' }, async $ => {
    await setPaneClosed(kv($), false)
    await ensureSession($)

    return {
      text: (await openPane($))
        ? 'Панель прогресса открыта.'
        : 'Панель не поместилась: план виден в строке под вводом.',
    }
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

    return renderChat($.ui.resolve(e), {
      record,
      project: projectOf(record, await $.session.root()),
      rows: e.props.scroll.bodyRows,
      columns: e.props.bodyColumns,
      storeFailed,
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
