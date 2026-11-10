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
  lastChange?: { added: number; percentBefore: number }
}

export type SessionRecord = {
  v: 1
  sessionId: string
  project: string
  plans: Plan[]
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

export type PaneState = {
  /** A surface draws the pane now; while it does, the status line is off. */
  isPlaced: boolean
  /** The turn ended and the next prompt has not come: the step waits on the person. */
  isWaiting: boolean
}

declare module 'claude-code' {
  interface PluginState {
    votaprogress: {
      session: Shaped<SessionState>
      flags: Flags
      pane: PaneState
    }
  }
}
