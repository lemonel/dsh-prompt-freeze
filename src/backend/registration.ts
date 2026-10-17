import { errorMessage, isObject } from './backend-values.js'
import type { FrozenSnapshot, Agent, RegistrationState, SessionState } from './types.js'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { PromptFreeze } from './host.js'
import type { Context } from '@deepseek-ai/cordis'
import { clone, revision } from './core.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isSourceKind, SOURCE_KIND } from './identity.js'

// Independent of snapshot revision and review generation.
export function registrationState(active: FrozenSnapshot, tools: Context['tools'], agent: Agent): RegistrationState {
  const names = [...new Set((active.mode === 'native' ? active.tools : [...active.callables, ...active.tools.filter(t => t.name === 'run_code')]).map(t => t.name))].sort()
  const body = { version: 1, entries: names.map(name => ({ name, registered: !!tools.get(name, agent) })) }
  return { ...body, revision: revision(body) }
}
export function validateRegistration(record: { registrationState?: unknown; registrationOutbox?: unknown; notice?: unknown }): void {
  const check = (state: unknown) => {
    if (!isObject(state) || state.version !== 1 || !Array.isArray(state.entries) || !state.entries.every((e: unknown) => isObject(e) && typeof e.name === 'string' && e.name.length > 0 && typeof e.registered === 'boolean') || new Set(state.entries.map((e: unknown) => isObject(e) ? e.name : undefined)).size !== state.entries.length) throw new Error('Invalid registration state')
    const { revision: hash, ...body } = state
    if (revision(body) !== hash) throw new Error('Registration integrity failure')
  }
  if (record.registrationState !== undefined) check(record.registrationState)
  if (record.registrationOutbox !== undefined) {
    if (!Array.isArray(record.registrationOutbox)) throw new Error('Invalid registration outbox')
    const ids = new Set<string>()
    const noticeMessage = isObject(record.notice) ? record.notice.message : undefined
    const noticeId = isObject(noticeMessage) ? noticeMessage.id : undefined
    for (const item of record.registrationOutbox) {
      if (!isObject(item)) throw new Error('Invalid registration outbox item')
      check(item.target)
      const m = item.message
      if (!isObject(m) || typeof m.id !== 'string' || !m.id.length || ids.has(m.id) || m.id === noticeId || m.role !== 'user' || !isObject(m.source) || !isSourceKind(m.source.kind) || m.source.form !== 'registration' || typeof m.source.summary !== 'string' || !Array.isArray(m.content) || m.content.length !== 1 || !isObject(m.content[0]) || m.content[0].type !== 'text' || typeof m.content[0].text !== 'string') throw new Error('Invalid registration outbox message')
      ids.add(m.id)
    }
  }
}
const own = (cut: SessionLogSnapshot | null, id: string) => cut?.events.some(e => e.seq >= cut.inheritedEventCount && e.type === 'user/message' && e.data.id === id)
const present = (cut: { events: SessionLogSnapshot["events"] } | null, id: string) => cut?.events.some(e => e.type === 'user/message' && e.data.id === id)
const bounded = (names: string[]) => ({ count: names.length, names: names.slice(0, 50).map(n => n.slice(0, 160)) })

// Caller owns the store serial lock. Never call serial/reconcile recursively here.
export async function prepareRegistration(host: PromptFreeze, state: SessionState, pendingApply = false) {
  if (!state.record) return null
  let baseline = state.record.registrationState
  let effective = baseline
  const pending = state.record.registrationOutbox ?? []
  const history = pending.length ? await host.owner.sessionQuery.readSession(state.agent.session.id) : null
  let surface = pending.length ? await host.owner.sessionQuery.readSurface(state.agent.session.id) : null
  const committed = pending.filter(item => own(history, item.message.id) && present(surface, item.message.id))
  let durable = false
  if (committed.length) {
    try {
      durable = await host.owner.sessions.flush(state.agent.session) && !!host.owner.get('sessionPersistence')
      state.registrationError = null
    } catch (error) {
      state.registrationError = `Registration acknowledgement deferred: ${errorMessage(error)}`
    }
    surface = await host.owner.sessionQuery.readSurface(state.agent.session.id)
  }
  const retained = []
  for (const item of committed) {
    if (!present(surface, item.message.id)) continue
    effective = item.target
    if (durable) baseline = item.target
    else retained.push(item) // Preserve immutable in-history evidence until durable.
  }
  const target = registrationState(state.record.active, host.owner.tools, state.agent)
  const previous = new Map((effective?.entries ?? []).map(e => [e.name, e.registered]))
  const missing = target.entries.filter(e => !e.registered && (previous.get(e.name) !== false || pendingApply)).map(e => e.name)
  const restored = target.entries.filter(e => e.registered && previous.get(e.name) === false).map(e => e.name)
  let message = null
  if (missing.length || restored.length) {
    const text = `Current frozen tool registration status: unavailable (not registered in this agent scope): ${JSON.stringify(bounded(missing))}; restored (registered again): ${JSON.stringify(bounded(restored))}. Lists show at most 50 names per category, each truncated to 160 characters; counts include omitted names. Frozen declarations and system prompt sections are retained unchanged. Do not call unavailable tools. Registered means registration only, not guaranteed execution or permission; implementations and permissions remain live.`
    // Reuse an unchanged, never-committed pending message; never mutate an in-history ID.
    const reusable = pending.find(item => !own(history, item.message.id) && item.target.revision === target.revision && (item.message.content[0] as { text?: string }).text === text)
    message = reusable?.message ?? createUserMessage({ source: { kind: SOURCE_KIND, form: 'registration', summary: 'Current frozen tool registration status' }, content: [{ type: 'text', text }] })
    retained.push({ target, message })
  } else {
    // No notification needed: initialize legacy/new names only at genuine user entry.
    // Preserve unflushed evidence; its target remains the effective baseline.
    if (!retained.length) baseline = target
  }
  const record = { ...state.record, ...(baseline ? { registrationState: baseline } : {}), registrationOutbox: retained }
  if (JSON.stringify(record.registrationState) !== JSON.stringify(state.record.registrationState) || JSON.stringify(record.registrationOutbox) !== JSON.stringify(state.record.registrationOutbox)) await host.commit(state, record)
  return message ? clone(message) : null
}
