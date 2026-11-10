// API shapes this module relies on (claude-code.d.ts, build 2.1.322):
// - a `tool.call` hook serving the mod's own tool answers `{ result }` (the
//   text the model reads) or `{ deny }` (the model reads it as an error);
// - `session.start` answers `{ cwd }` from `next(e)`; it fires once per
//   process and never after /clear, so the session is checked on every call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionRecord } from './plan'
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

export const register: Register = on => {
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
}
