import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Stats } from 'node:fs'

export type { Agent, Context, PromptAssembly, ToolSchema, UserMessage }
export type SessionId = Agent['session']['id']
export type ToolMode = 'native' | 'ptc' | 'both'
export type RecoveryChoice = 'keep' | 'recapture'
export type AutoApplySetting = string | null
export interface PromptFreezeConfig { directory?: string; autoApplyBelow?: string; nonInteractive?: 'auto-keep' | 'block' }
export interface FrozenSection { name: string; text: string; interpolate: boolean }
interface SnapshotBase { revision: string; mode: ToolMode; tools: ToolSchema[]; callables: ToolSchema[]; sections: FrozenSection[] }
/** Historical snapshots freeze SDK sections only; layout, if present, is not authoritative. */
export interface LegacySnapshot extends SnapshotBase { coverage?: undefined; sectionLayout?: string[] }
/** Full coverage requires the saved ordering, including live-section anchors. */
export interface NamedSectionsSnapshot extends SnapshotBase { coverage: 'named-sections-v1'; sectionLayout: string[] }
export type FrozenSnapshot = LegacySnapshot | NamedSectionsSnapshot
export interface ObservedSection { name: string; text: string; live: boolean }
export interface ObservedContext { name: string; text: string }
export interface ObservedVariable { name: string; defined: boolean; value?: string }
export interface Observation { revision: string; sections: ObservedSection[]; tools: ToolSchema[]; contexts: ObservedContext[]; variables: ObservedVariable[] }
export interface Checkpoint { count: number; inheritedEventCount: number; hash: string; time: number }
export interface RegistrationState { version: number; entries: { name: string; registered: boolean }[]; revision: string }
export interface RegistrationNotice { target: RegistrationState; message: UserMessage }
export interface SnapshotRecord { format: number; profileIdentity: string; sessionId: SessionId; generation: number; active: FrozenSnapshot; observation?: Observation | null; checkpoint: Checkpoint | null; registrationState?: RegistrationState; registrationOutbox?: RegistrationNotice[]; notice: { from: FrozenSnapshot | null; message: UserMessage } | null; kept: string | null; legacy?: boolean }
/** Legacy storage may contain only a marker, with no recoverable active snapshot. */
export type LoadedRecord = SnapshotRecord | { legacy: true; active?: never; generation?: never }
export interface PayloadReference { record: SnapshotRecord; hash: string; stat: Stats; uncertain?: boolean }
export interface SessionSettings { revision: number; value: AutoApplySetting }
export interface RecoveryRequest { id: string; phase: 'pending' | 'awaiting-choice' | RecoveryChoice; error?: string; auto?: boolean; autoBlocked?: boolean; estimatedContextInputTokens?: number; frozenContentMatches?: boolean; deferredMessage?: { text: string } }
export interface UsageCounters { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export type UsageStatus = 'pending' | 'not-called' | 'unavailable' | 'reported'
export interface RecoveryUsageResult { id: string; usageStatus: UsageStatus; usageReason?: string; usage?: UsageCounters }
export interface RecoveryOutcome extends RecoveryUsageResult { kind: string; auto: boolean }
export interface UsageToken { id: string; signal: AbortSignal; text: string; tools: string; claimed: boolean; done: boolean; abort?: () => void; turn?: number; step?: number }
export interface AutoApplyMetadata { thresholdTokens: number | null; settingsRevision: number; override: AutoApplySetting; defaultThresholdTokens: number | null; settingsError?: string; inputTokens: number | null; inputStale: boolean; eligible: boolean; error?: string }
export interface ChildRecovery { sessionId: SessionId; kind: string; label: string | null }
export interface SessionState {
  agent: Agent; record: SnapshotRecord | null; candidate: FrozenSnapshot | null; observation?: Observation | null; candidateAssembly?: PromptAssembly;
  loaded: boolean; loading: Promise<void> | null; disposed?: boolean; error: string | null; probeError: string | null; noticeError: string | null;
  busy: boolean; dirty: boolean; scheduled: boolean; noticeState: string;
  observations: { text: string; snapshot: FrozenSnapshot; observation: Observation }[]; observationOverflow: boolean;
  captureError: string | null; recoveryWarning: string | null; checkpointError: string | null;
  checkpointJob: Promise<void> | null; checkpointDirty: boolean; autoJob?: Promise<unknown>;
  deferredMessage: { id: string | null; text: string } | null; childRecoveries: ChildRecovery[] | null;
  settings?: SessionSettings; settingsError?: string | null; registrationError?: string | null; lastInputTokens?: number; autoApply?: AutoApplyMetadata;
  quarantine?: SnapshotRecord | null; recovery?: RecoveryRequest | null; recoveryOutcome?: RecoveryOutcome;
  recoveryUsage?: UsageToken | null; recoveryUsageArmed?: string; recoveryUsageResult?: RecoveryUsageResult | null;
  answerRecovery?: (() => void) | null; cancelRecovery?: (() => void) | null; removeRecoveryAbort?: (() => void) | null;
}

/** Sources persisted by this plugin (including both historical identities). */
export interface FreezeMessageSource { kind: 'prompt-freeze'; form: 'notice' | 'registration'; summary: string }
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prompt-freeze': FreezeMessageSource
    'tool-declaration-snapshot': { kind: 'tool-declaration-snapshot'; form: 'notice' | 'registration'; summary: string }
    'cache-guard': { kind: 'cache-guard'; form: 'notice' | 'registration'; summary: string }
    'runtime-context': { kind: 'runtime-context' }
  }
}
export interface ObservationRow { name: string; live?: boolean; before?: ObservationRow; after?: ObservationRow }
export interface ObservationDelta { added: ObservationRow[]; removed: ObservationRow[]; changed: ObservationRow[]; beforeOrder: string[]; afterOrder: string[]; orderChanged: boolean }

export type ObservationUnit = "sections" | "tools" | "contexts" | "variables"
export type ObservationDiff = Record<ObservationUnit, ObservationDelta>
