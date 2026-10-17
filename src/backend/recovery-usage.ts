import type { SessionState, UsageToken, UsageCounters, UsageStatus, PromptAssembly } from './types.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { revision } from './core.js'

export function finalSystem(options: GenerateOptions) {
  for (const message of options.messages.filter(m => m.role === 'system').reverse()) {
    const value = typeof message.content === 'string' ? message.content : Array.isArray(message.content) && message.content.every(b => b.type === 'text' && typeof b.text === 'string') ? message.content.map(b => b.text).join('') : null
    if (value !== '') return value
  }
  return ''
}
export function counters(value: unknown): UsageCounters | null {
  if (!value || typeof value !== 'object' || !('inputTokens' in value) || typeof value.inputTokens !== 'number' || !Number.isFinite(value.inputTokens) || value.inputTokens < 0) return null
  const result: UsageCounters = { inputTokens: value.inputTokens }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens'] as const) {
    const counter: unknown = key === 'cacheReadTokens'
      ? ('cacheReadTokens' in value ? value.cacheReadTokens : undefined)
      : ('cacheWriteTokens' in value ? value.cacheWriteTokens : undefined)
    if (counter === undefined) continue
    if (typeof counter !== 'number' || !Number.isFinite(counter) || counter < 0) return null
    result[key] = counter
  }
  return result
}
export function settleUsage(state: SessionState, token: UsageToken, status: UsageStatus, reason?: string | null, usage?: UsageCounters | null): void {
  if (!token || token.done) return
  token.done = true
  if (token.abort) token.signal.removeEventListener('abort', token.abort)
  const result = { id: token.id, usageStatus: status, ...(reason ? { usageReason: reason } : {}), ...(usage ? { usage } : {}) }
  state.recoveryUsageResult = result
  if (state.recoveryOutcome?.id === token.id) Object.assign(state.recoveryOutcome, result)
  if (state.recoveryUsage === token) state.recoveryUsage = null
}
export function expireUsage(state: SessionState, reason: string, includeClaimed = false) {
  const token = state.recoveryUsage
  if (token && (!token.claimed || includeClaimed)) settleUsage(state, token, token.claimed ? 'unavailable' : 'not-called', reason)
}
export function armUsage(state: SessionState, assembly: PromptAssembly, context: AssembleContext) {
  const id = state.recovery?.id
  if (!id || !context.signal || state.agent.status !== 'running' || state.recoveryUsageArmed === id) return
  state.recoveryUsageArmed = id
  state.recoveryUsageResult = null
  const token: UsageToken = { id, signal: context.signal, text: renderPrompt(assembly), tools: revision(assembly.tools ?? []), claimed: false, done: false }
  token.abort = () => { if (!token.claimed) settleUsage(state, token, 'not-called', 'Recovery assembly was cancelled before a request') }
  state.recoveryUsage = token
  token.signal.addEventListener('abort', token.abort, { once: true })
  if (token.signal.aborted) token.abort()
}
export function bindUsage(state: SessionState, payload: { signal: AbortSignal; turn: number; step: number }, decision: { kind: string }) {
  const token = state.recoveryUsage
  if (!token || token.claimed || token.signal !== payload.signal) return
  if (decision.kind !== 'enter' || payload.signal.aborted) return settleUsage(state, token, 'not-called', 'Recovery pre-step was rejected or cancelled')
  token.turn = payload.turn; token.step = payload.step
}
export function claimUsage(state: SessionState | undefined, options: GenerateOptions): UsageToken | null {
  const token = state?.recoveryUsage
  if (!token || token.claimed || token.done) return null
  if (token.signal !== options.signal || token.turn === undefined || token.step === undefined || token.text !== finalSystem(options) || token.tools !== revision(options.tools ?? [])) {
    settleUsage(state, token, 'not-called', 'Request could not be associated exactly with the recovery assembly')
    return null
  }
  token.claimed = true
  return token
}
export async function* trackedStream(state: SessionState, token: UsageToken, next: () => AsyncIterable<StreamChunk>) {
  let usage: UsageCounters | null = null
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage = counters(chunk.usage)
      if (chunk.type === 'finish') settleUsage(state, token, usage ? 'reported' : 'unavailable', usage ? null : 'The tracked stream did not report valid input usage', usage)
      yield chunk
    }
  } finally {
    settleUsage(state, token, usage ? 'reported' : 'unavailable', usage ? null : 'The tracked stream ended without valid input usage', usage)
  }
}
