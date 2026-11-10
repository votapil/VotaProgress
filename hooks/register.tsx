// API shapes this module relies on (claude-code.d.ts, build 2.1.322):
// - a `tool.call` hook serving the mod's own tool answers `{ result }` (the
//   text the model reads) or `{ deny }` (the model reads it as an error);
// - `session.start` answers `{ cwd }` from `next(e)`; it fires once per
//   process and never after /clear, so the session is checked on every call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { activePlan, closePlan, shouldAutoClose } from './plan'
import type { SessionRecord } from './plan'
import { NUDGE, RULE, replanText } from './rule'
import { applyDrops, emptyRecord, loadRecord, prune, saveRecord } from './storage'
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

/** The record of the session the process runs now, raised from the store when it changed. */
export const ensureSession = async ($: $): Promise<SessionRecord> => {
  const id = await $.session.id()
  const held = await read($, session)

  if (held.owner === id && held.record) {
    return held.record
  }

  const stored = await loadRecord(kv($), id)
  const record = stored
    ? await applyDrops(kv($), stored, await nowIso($))
    : emptyRecord(id, await $.session.root())

  if (stored && record !== stored) {
    await saveRecord(kv($), record)
  }

  await update($, session, () => ({ owner: id, record }))

  return record
}

/** Keeps a changed record: the state first, then the store, which may refuse. */
export const commit = async ($: $, record: SessionRecord): Promise<void> => {
  await update($, session, () => ({ owner: record.sessionId, record }))
  const isSaved = await saveRecord(kv($), record)
  await update($, flags, held => ({ ...held, storeFailed: !isSaved }))
}

const OWN = 'mcp__votaprogress__progress'
const EDITING = new Set(['Edit', 'Write', 'NotebookEdit'])
const NUDGE_AT = 3

/** The plan the model is owed after a compaction, once; `undefined` when none is. */
const takeReplan = async ($: $): Promise<string | undefined> => {
  if (!(await read($, flags)).replanPending) {
    return undefined
  }

  const plan = activePlan(await ensureSession($))

  if (!plan) {
    return undefined
  }

  await update($, flags, held => ({ ...held, replanPending: false }))

  return replanText(plan)
}

export const register: Register = on => {
  // This turn's file edits made without a plan, and whether the model was told.
  let edits = 0
  let isNudged = false

  on('session.start', async ($, e, next) => {
    await $.tool.register(toolSpec)
    await ensureSession($)
    await prune(kv($), await nowIso($))

    return next(e)
  })

  on('tool.call', { tool: 'mcp__votaprogress__progress' }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'план ведёт основная сессия' }
    }

    const record = await ensureSession($)
    const out = handle(record, e, await nowIso($))

    if (out.isError) {
      return { deny: out.text }
    }

    await commit($, out.record)

    return { result: out.text }
  })

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
    const replan = await takeReplan($)

    return next(replan === undefined ? e : { ...e, context: [...(e.context ?? []), replan] })
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined || e.tool === OWN || ran.deny !== undefined) {
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
    if (e.agentId === undefined) {
      await update($, flags, held => ({ ...held, replanPending: true }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const record = await ensureSession($)
      const plan = activePlan(record)

      if (plan && shouldAutoClose(plan)) {
        const closed = closePlan(plan, 'done', await nowIso($)).plan
        await commit($, {
          ...record,
          plans: record.plans.map(one => (one.id === closed.id ? closed : one)),
        })
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const held = await read($, session)

    if (held.owner === e.sessionId && held.record && held.record.plans.length > 0) {
      await saveRecord(kv($), { ...held.record, endedAt: await nowIso($), endReason: e.reason })
    }

    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, session, () => ({ owner: null, record: null }))
    }

    return next(e)
  })
}
