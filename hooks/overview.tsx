// The pane's «all projects» view: every session's plans by folder, one plan
// in full with the line that brings its chat back. Draws from values; what a
// press does comes in as `on`.

import type { ElementTable, RenderSurface } from 'claude-code'

import type { PaneState } from '../types'
import { clip, counts } from './plan'
import type { Step } from './plan'
import { PAGE, PERIOD_LABEL, STATUS_LABEL, isStale, resumeCommand, rowNote, shortDate } from './query'
import type { Folder, Row } from './query'

const HEAVY = '◆'
const MARK = { active: '◐', done: '✓', abandoned: '×' } as const
const STEP_MARK = { done: '✓', active: '◐', pending: '○' } as const

export type OverviewActions = {
  chat(): void
  refresh(): void
  folder(project: string): void
  plan(key: string): void
  more(project: string): void
  copy(text: string, surface: RenderSurface): void
  drop(row: Row): void
  search(text: string): void
  status(): void
  period(): void
  reset(): void
}

export type OverviewView = {
  /** `null` while the store has not been read since the module loaded. */
  folders: Folder[] | null
  state: PaneState
  columns: number
  now: string
  on: OverviewActions
}

/** A search opens every folder; otherwise a folder is as the person left it, the current one open. */
export const isFolderOpen = (folder: Folder, state: PaneState): boolean =>
  state.query.trim() !== '' || (state.folders[folder.project] ?? folder.isCurrent)

export const renderOverview = <S extends RenderSurface>(table: ElementTable<S>, view: OverviewView) => {
  const { Box, Button, Input, Text } = table
  const { state, on } = view
  const width = (text: string): number => [...text].length
  // The first unfinished plan of this folder holds the focus ring when the
  // pane takes the keys.
  const focused = view.folders
    ?.find(folder => folder.isCurrent)
    ?.rows.find(row => row.plan.status === 'active')?.key

  const stepRow = (step: Step) => {
    const right = step.weight === 3 && step.status !== 'done' ? HEAVY : undefined
    const left = STEP_MARK[step.status as keyof typeof STEP_MARK] + ' ' + step.text

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor={step.status !== 'active'}>
          {clip(left, Math.max(1, view.columns - 4 - (right === undefined ? 0 : width(right) + 1)))}
        </Text>
        {right === undefined ? null : <Text dimColor>{right}</Text>}
      </Box>
    )
  }

  const opened = (row: Row) => {
    const command = resumeCommand(row.project, row.sessionId)

    return (
      <Box flexDirection="column" paddingLeft={2}>
        {row.plan.steps.filter(step => step.status !== 'dropped').map(stepRow)}
        {row.isOwn ? (
          <Text dimColor>это этот чат</Text>
        ) : (
          <Box flexDirection="column">
            <Text wrap="wrap">{command}</Text>
            <Box flexDirection="row" gap={2}>
              <Button
                key="copy"
                plain
                hotkey="c"
                label="копировать запуск"
                onPress={press => on.copy(command, press.surface)}
              />
              {row.plan.status === 'active' && (
                <Button key="drop" plain hotkey="x" label="выбросить" onPress={() => on.drop(row)} />
              )}
            </Box>
          </Box>
        )}
      </Box>
    )
  }

  const planRow = (row: Row) => {
    const tally = counts(row.plan)
    const right = tally.done + ' из ' + tally.total
    const isDim = isStale(row.plan, view.now)
    const note = rowNote(row)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Button
            key={'p:' + row.key}
            plain
            {...(isDim ? { dimColor: true } : {})}
            {...(row.key === focused ? { autoFocus: true as const } : {})}
            label={clip(MARK[row.plan.status] + ' ' + row.plan.goal, Math.max(1, view.columns - 1 - width(right) - 1))}
            onPress={() => on.plan(row.key)}
          />
          <Text dimColor={isDim}>{right}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>{shortDate(row.plan.updatedAt, view.now) + (note ? ' · ' + note : '')}</Text>
        </Box>
        {state.openPlan === row.key && opened(row)}
      </Box>
    )
  }

  const folderBlock = (folder: Folder) => {
    const isOpen = isFolderOpen(folder, state)
    const right = folder.unfinished + ' не закончено'
    const shown = PAGE + (state.more[folder.project] ?? 0)
    const label = (isOpen ? '▾ ' : '▸ ') + folder.name + (folder.isCurrent ? ' (текущий)' : '')

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button
            key={'f:' + folder.project}
            plain
            label={clip(label, Math.max(1, view.columns - width(right) - 1))}
            onPress={() => on.folder(folder.project)}
          />
          <Text dimColor>{right}</Text>
        </Box>
        {isOpen && (
          <Box flexDirection="column" paddingLeft={1}>
            {folder.rows.slice(0, shown).map(planRow)}
            {folder.rows.length > shown && (
              <Button key={'more:' + folder.project} label={'ещё ' + PAGE} onPress={() => on.more(folder.project)} />
            )}
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Button key="chat" plain hotkey="b" label="этот чат" onPress={() => on.chat()} />
        <Button key="refresh" plain hotkey="r" label="обновить" onPress={() => on.refresh()} />
      </Box>
      <Input
        key="q"
        label="Поиск: "
        value={state.query}
        submitLabel="найти"
        onInput={value => on.search(value)}
        onSubmit={value => on.search(value)}
      />
      <Box flexDirection="row" gap={1}>
        <Button key="status" label={'Статус: ' + STATUS_LABEL[state.status]} onPress={() => on.status()} />
        <Button key="period" label={'Период: ' + PERIOD_LABEL[state.period]} onPress={() => on.period()} />
      </Box>
      {view.folders === null && <Text dimColor>загрузка…</Text>}
      {view.folders?.length === 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>ничего не найдено</Text>
          <Button key="reset" label="сбросить фильтры" onPress={() => on.reset()} />
        </Box>
      )}
      {view.folders?.map(folderBlock)}
    </Box>
  )
}
