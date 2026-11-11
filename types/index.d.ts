// The mod's contract: every value it keeps in `$.state`, and the plan model
// those values are made of. Self-contained: it imports nothing.

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
}

export type SessionRecord = {
  v: 1
  sessionId: string
  project: string
  plans: Plan[]
  /** When the context was compacted, oldest first, the last 20 kept. */
  compactions?: string[]
  endedAt?: string
  endReason?: string
}

/** The session whose record the state holds, and the record itself. */
export type SessionState = { owner: string | null; record: SessionRecord | null }

export type Flags = {
  /** The store refused the last write: plans live in memory only. */
  storeFailed: boolean
  /** The context was compacted: the model is owed the plan again. */
  replanPending: boolean
}

/** What the pane shows and how the person left the overview. */
export type PaneState = {
  view: 'chat' | 'all'
  /** Folders opened (true) or closed (false) by hand, by project path. */
  folders: Record<string, boolean>
  /** The one plan shown in full, `sessionId:planId`. */
  openPlan: string | null
  /** Plans a folder shows past its first page, by project path. */
  more: Record<string, number>
  /** Bumped each time the overview rereads the store: the pane redraws. */
  rev: number
}

declare module 'claude-code' {
  interface PluginState {
    votaprogress: {
      session: Shaped<SessionState>
      flags: Flags
      pane: Shaped<PaneState>
    }
  }
}
