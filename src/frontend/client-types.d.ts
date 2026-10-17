import type { ReactElement } from 'react'

export type Unit = 'tools' | 'sections' | 'contexts' | 'variables'
export type ChangeKind = 'added' | 'removed' | 'changed'
export type Translator = (key: string, params?: Record<string, unknown>) => string
export type DisplayError = string & { localeKey?: never } | { localeKey: string }
export interface ContentValue {
  [field: string]: unknown
  name?: string
  text?: string
  live?: boolean
  unavailable?: boolean
  defined?: boolean
}
export interface DiffRow extends ContentValue {
  name: string
  before?: ContentValue | string
  after?: ContentValue | string
}
export interface CategoryDiff {
  added?: Array<DiffRow | string>
  removed?: Array<DiffRow | string>
  changed?: DiffRow[]
  beforeOrder?: string[]
  afterOrder?: string[]
  orderChanged?: boolean
}
export type DisplayDelta = { available: false; partial: boolean } | {
  available: true
  partial: boolean
  added: DiffRow[]
  removed: DiffRow[]
  changed: DiffRow[]
  beforeOrder: string[]
  afterOrder: string[]
  orderChanged?: boolean
}
export interface SnapshotView {
  revision?: string
  tools?: DiffRow[]
  callables?: DiffRow[]
}
export interface AutoApplyView {
  settingsRevision?: number
  override?: string
  thresholdTokens?: number
  defaultThresholdTokens?: number
  eligible?: boolean
  error?: string
  settingsError?: string
}
export interface RecoveryOutcome {
  id?: string
  kind: string
  usageStatus?: string
  usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}
export interface RecoveryView {
  id: string
  phase: string
  error?: string
  frozenContentMatches?: boolean
  estimatedContextInputTokens?: number
  deferredMessage?: { text?: string }
}
export interface ChildRecovery { label?: string; sessionId?: string }
export interface PanelState {
  active?: SnapshotView
  candidate?: SnapshotView
  generation?: number
  diff?: CategoryDiff & { sections?: CategoryDiff; sdkChanged?: boolean; modeChanged?: boolean }
  observation?: { baselineAvailable?: boolean; baseline?: { revision?: string }; diff?: Partial<Record<Unit, CategoryDiff>> }
  autoApply?: AutoApplyView
  recovery?: RecoveryView
  recoveryOutcome?: RecoveryOutcome
  error?: string
  checkpointError?: string
  recoveryWarning?: boolean
  awaitingFirstCall?: boolean
  baselineRequired?: boolean
  upgradeRequired?: boolean
  registrationError?: string
  registrationPending?: number
  busy?: boolean
  noticeState?: string
  liveChanges?: Partial<Record<Unit, { count?: number }>>
  childRecoveries?: ChildRecovery[]
}
export interface SettingsState {
  draft: string
  savedDraft?: string
  baseRevision: number | null
  dirty: boolean
  conflict: boolean
  pending: boolean
  error: DisplayError
  result: boolean
}
export type RemoteMethod = 'summary' | 'status' | 'resolveRecovery' | 'setAutoApply' | 'acknowledgeObservation' | 'applySnapshot'
export type RemoteResponse = { ok: true; value: PanelState } | { ok: false; error?: { message?: string } }
export type PromptFreezeRemote = Record<RemoteMethod, (sessionId: string, ...args: unknown[]) => Promise<RemoteResponse>>
export interface PanelProps { sessionId: string; promptFreezeRemote: PromptFreezeRemote; t?: Translator }
export interface QueuedRequest {
  receive: (value: PanelState) => void
  method: RemoteMethod
  invoke: () => Promise<RemoteResponse>
  onSuccess?: (value: PanelState) => void
  epoch: number | null
  valid: () => boolean
  resolve: () => void
}
export interface LineRow { kind: ' ' | '+' | '-'; text: string; oldLine: number | null; newLine: number | null }
export interface LineDiff { rows: LineRow[]; fallback: boolean; oldCount: number; newCount: number }
export interface FormattedValue { unavailable?: boolean; text: string }
export type ItemDiff = {
  unavailable: string[]
  knownBefore: string | null
  knownAfter: string | null
} | (LineDiff & {
  unavailable: []
  beforeAbsent: boolean
  afterAbsent: boolean
})
export interface LocalesApi {
  NS: string
  dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>
  standaloneTranslator: (language?: string) => Translator
}
export interface ClientContext {
  effect: (callback: () => unknown, label: string) => unknown
  locale: { register: (namespace: string, dictionaries: LocalesApi['dictionaries']) => unknown }
  remote: { $mount: (descriptor: unknown) => Promise<unknown>; promptFreeze: PromptFreezeRemote }
  inject: (dependencies: string[], callback: (child: ClientContext) => void) => unknown
  slots: {
    inject: (slot: string, callback: () => unknown) => unknown
    register: (options: { name: string; id: string; locale: string; order: number; inject: () => { promptFreezeRemote: PromptFreezeRemote } }, render: (props: PanelProps) => ReactElement) => unknown
  }
}
