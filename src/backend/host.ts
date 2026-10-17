import { errorMessage } from './backend-values.js'
import type { AutoApplyMetadata, ToolMode, Context, Agent, SessionId, SessionState, PromptFreezeConfig, SnapshotRecord, FrozenSnapshot, RecoveryChoice, AutoApplySetting, UserMessage, Observation } from './types.js'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { UsageToken, ObservationUnit } from './types.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Store, snapshot, project, diff, clone, expandedCoverage, revision, observe, observationDiff, rebaselineObservation, DIAGNOSTIC_UNITS, isLiveObservationRow } from './core.js'

import { checkpoint, matches, durableCut } from './recovery.js'

import { registrationState, prepareRegistration } from './registration.js'
import { SOURCE_KIND } from './identity.js'
import { parseThreshold, estimateInput } from './auto-apply.js'
import { Settings, validateSetting } from './settings.js'

import { armUsage, bindUsage, claimUsage, expireUsage, trackedStream } from './recovery-usage.js'

const PROBE = Symbol('prompt-freeze probe')
type ProbeContext = AssembleContext & { [PROBE]?: { snapshot?: FrozenSnapshot; observation?: Observation } }
export class PromptFreeze extends TypertRemoteService {
  declare thresholdTokens: number | null
  declare nonInteractive: 'auto-keep' | 'block'
  declare owner: Context
  declare store: Store
  declare states: Map<SessionId, SessionState>
  declare stopped: boolean
  declare childParents: Map<SessionId, { sessionId: SessionId; label: string | null }>
  declare settings: Settings
  static inject = ['agents', 'sessions', 'sessionQuery', 'systemPrompt', 'tools']
  constructor(ctx: Context, config: PromptFreezeConfig) {
    super(ctx, 'promptFreeze', { namespace: 'promptFreeze' })
    this.thresholdTokens = parseThreshold(config.autoApplyBelow === undefined ? '24K' : config.autoApplyBelow)
    // A delegated agent (subagent) has nobody at its input to answer a recovery prompt, so waiting there
    // would hang the parent's delegation forever. `auto-keep` continues from the quarantined snapshot —
    // the choice that preserves the cached prefix — and records it as an automatic decision;
    // `block` keeps the fail-closed behaviour and lets a user decide in that session.
    this.nonInteractive = config.nonInteractive ?? 'auto-keep'
    this.owner = ctx; this.store = new Store(config.directory, ctx.get('profileContext')?.dir); this.states = new Map(); this.stopped = false
    // Delegated child session → the parent session whose panel should surface the child's automatic
    // decisions. Populated from each parent's subagent/catalog events, best effort (live parents only).
    this.childParents = new Map()
    this.settings = new Settings(this.store)
    ctx.on('agent/inbox/inserted', ({ agent, message }) => this.autoInserted(agent, message))
    // The loop claims a turn's input before the request is assembled, so neither the inbox nor the log
    // still shows it while a recovery hold is in progress. This is the message that hold is about; the
    // panel offers its text back when a cancelled turn leaves it unanswered.
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message?.source?.kind !== 'user') return
      const state = this.states.get(agent.session.id)
      if (!state) return
      const text = (message.content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => (block as { text: string }).text).join('\n')
      if (text) state.deferredMessage = { id: message.id ?? null, text }
    })
    ctx.on('agent/created', async ({ agent }) => { await this.load(agent) })
    ctx.on('system-prompt/assemble', async (_input, context, next) => {
      const candidate = await next()
      const agent = context.agent
      if (!agent?.session) return candidate
      if (context.scope !== agent) throw new Error('Assembly agent/scope mismatch')
      const mode = (ctx.tools as unknown as { modeFor(agent: Agent): ToolMode }).modeFor(agent)
      const snap = snapshot(candidate, mode === 'native' ? candidate.tools : ctx.tools.schemas(agent), mode, renderPrompt)
      const observation = observe(candidate, renderPrompt, renderContextSections)
      const marker = (context as ProbeContext)[PROBE]
      if (marker) { marker.snapshot = snap; marker.observation = observation; return candidate }
      const state = this.state(agent)
      await this.load(agent)
      if (context.signal && agent.status === 'running') expireUsage(state, 'A later assembly replaced the unclaimed recovery request')
      state.candidate = snap
      state.observation = observation
      await this.guardRecovery(state, { signal: context.signal, wait: true })
      if (state.recovery?.phase === 'keep') {
        try {
          context.signal?.throwIfAborted()
          const old = state.quarantine
          if (!old) throw new Error('Missing recovery snapshot')
          if (old.active.mode !== snap.mode) throw new Error('Recovery mode incompatible; choose recapture on the next idle user send')
          const projected = project(candidate, old.active)
          if (!context.signal || agent.status !== 'running') return projected
          await this.store.serial(agent.session.id, async () => {
            context.signal?.throwIfAborted()
            if (this.stopped || state.disposed) throw new Error('Snapshot recovery stopped')
            await this.commit(state, { ...old, legacy: undefined, checkpoint: null, generation: old.generation + 1,
              notice: null, kept: null, registrationOutbox: [], registrationState: this.initialRegistration(old.active, agent) })
          })
          context.signal.throwIfAborted()
          if (this.stopped || state.disposed) throw new Error('Snapshot recovery stopped')
          armUsage(state, projected, context)
          this.finishRecovery(state, old.active.revision === snap.revision ? 'kept-unchanged' : 'kept-changed')
          this.scheduleCheckpoint(state)
          return projected
        } catch (error) { this.failRecovery(state, error); throw error }
      }
      if (state.recovery && state.error) throw new Error(state.error)
      if (!state.record) {
        if (state.recovery?.phase === 'recapture') armUsage(state, candidate, context)
        const text = renderPrompt(candidate)
        if (!state.observations.some(item => item.text === text && item.snapshot.revision === snap.revision && item.observation?.revision === observation.revision)) {
          if (state.observations.length < 32) state.observations.push({ text, snapshot: snap, observation })
          else state.observationOverflow = true
        }
        return candidate
      }
      if (state.error || state.probeError) throw new Error(state.error || state.probeError || '')
      if (state.record.active.mode !== snap.mode) throw new Error('Tool presentation changed; apply the reviewed mode while idle before continuing')
      return project(candidate, state.record.active)
    }, { prepend: true })
    const host = this
    ctx.on('llm/stream', (options, next) => (async function* () {
      let usageState: SessionState | undefined, usageToken: UsageToken | null = null
      if (isAgentLoopRequest(options) && !options.purpose && !options.signal?.aborted) {
        const recoveryState = options.sessionId ? host.states.get(options.sessionId) : undefined
        if (recoveryState) await host.guardRecovery(recoveryState, { signal: options.signal, wait: true })
        usageState = recoveryState
        usageToken = recoveryState ? claimUsage(recoveryState, options) : null
        try { await host.capture(options) }
        catch (error) {
          const state = options.sessionId ? host.states.get(options.sessionId) : undefined
          if (state) state.captureError = `Initial snapshot capture failed: ${errorMessage(error)}`
        }
      }
      if (usageToken && usageState) yield* trackedStream(usageState, usageToken, next)
      else yield* next()
    })())
    ctx.on('agent/pre-step', async (payload, next) => {
      let decision
      try { decision = await next() }
      catch (error) { expireUsage(this.state(payload.agent), 'Recovery pre-step failed'); throw error }
      bindUsage(this.state(payload.agent), payload, decision)
      if (decision.kind !== 'enter' || payload.signal.aborted || !payload.messages.some(m => m.source?.kind === 'user')) return decision
      const state = this.state(payload.agent)
      await this.load(payload.agent)
      // The assembly already held this turn and recorded the message it is about; this pass only has to
      // apply whatever the user chose (or fail fast when recovery is still unresolved).
      await this.guardRecovery(state, { signal: payload.signal, wait: true })
      if (!decision.messages.some(m => m.source?.kind === 'user')) return decision
      let alreadyCommitted
      try { alreadyCommitted = await this.reconcile(payload.agent) }
      catch (error) {
        // A failed Apply flush must not suppress independent registration changes.
        // Only proceed with positive own-history + surface evidence; otherwise fail closed.
        state.noticeError = errorMessage(error)
        const id = state.record?.notice?.message.id
        const history = await this.owner.sessionQuery.readSession(payload.agent.session.id)
        const surface = await this.owner.sessionQuery.readSurface(payload.agent.session.id)
        if (!id || !history.events.some(e => e.seq >= history.inheritedEventCount && e.type === 'user/message' && e.data.id === id) || !surface.events.some(e => e.type === 'user/message' && e.data.id === id)) throw error
        alreadyCommitted = true
      }
      return this.store.serial(payload.agent.session.id, async () => {
        const registration = await prepareRegistration(this, state, !alreadyCommitted && !!state.record?.notice)
        const messages = [...decision.messages]
        if (!alreadyCommitted && state.record?.notice) messages.push(clone(state.record.notice.message))
        if (registration) messages.push(registration)
        return { ...decision, messages }
      })
    }, { prepend: true })
    for (const event of ['tools/change', 'system-prompt/change'] as const) ctx.on(event, () => this.dirty())
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') { expireUsage(this.state(agent), 'Recovery assembly did not produce a request'); this.schedule(agent); this.scheduleCheckpoint(this.state(agent)) } })
    ctx.on('session/event', (session, rawEvent) => {
      const event = rawEvent as unknown as { type: string; data: { childId?: SessionId; label?: string; id?: string } }
      const state = this.states.get(session.id)
      // A parent appends one catalog entry per delegated child; that is how a child's automatic keep finds
      // the session whose panel should show it.
      if (event.type === 'subagent/catalog' && typeof event.data?.childId === 'string') {
        this.childParents.set(event.data.childId, { sessionId: session.id, label: typeof event.data.label === 'string' ? event.data.label : null })
        if (this.childParents.size > 500) { const oldest = this.childParents.keys().next().value; if (oldest !== undefined) this.childParents.delete(oldest) }
      }
      if (state) this.scheduleCheckpoint(state)
      if (state && event.type === 'user/message' && state.record?.notice?.message.id === event.data.id) state.noticeState = 'committed-not-durable'
    })
    ctx.on('agent/disposed', ({ agent }) => { const state = this.states.get(agent.session.id); if (state) { expireUsage(state, 'Agent disposed', true); state.disposed = true; state.cancelRecovery?.(); } this.states.delete(agent.session.id); this.store.forget(agent.session.id) })
    ctx.effect(() => async () => { this.stopped = true; for (const state of this.states.values()) { expireUsage(state, 'Plugin stopped', true); if (state.recovery) state.agent.cancel({ kind: 'disposed' }); state.cancelRecovery?.(); } await Promise.allSettled([...this.store.queues.values(), ...[...this.states.values()].map(state => state.autoJob).filter(Boolean), ...[...this.states.values()].map(state => state.checkpointJob).filter(Boolean)]) })
  }
  state(agent: Agent): SessionState {
    let state = this.states.get(agent.session.id)
    if (!state) { state = { agent, record: null, candidate: null, loaded: false, loading: null, error: null, probeError: null, noticeError: null, busy: false, dirty: true, scheduled: false, noticeState: 'none', observations: [], observationOverflow: false, captureError: null, recoveryWarning: null, checkpointError: null, checkpointJob: null, checkpointDirty: false, deferredMessage: null, childRecoveries: null }; this.states.set(agent.session.id, state) }
    return state
  }
  agent(id: SessionId): Agent { const agent = this.owner.agents.get(id); if (!agent) throw new Error('Session has no live agent; open/resume it first'); return agent }
  async load(agent: Agent) {
    const state = this.state(agent)
    if (state.loaded) return
    if (!state.loading) state.loading = (async () => {
      await this.store.serial(agent.session.id, async () => {
        try { state.settings = await this.settings.read(agent.session.id); state.settingsError = null }
        catch (error) { state.settingsError = `Auto-apply settings failed: ${errorMessage(error)}` }
        try {
          const loaded = await this.store.load(agent.session.id)
          if (!loaded) return
          if (!loaded.active) throw new Error('Legacy record has no recoverable snapshot; explicitly confirm a new baseline')
          const record = loaded
          // Read raw durability BEFORE any flush owned by this plugin.
          let durable = null, live = null
          try {
            durable = await durableCut(this.owner, agent.session.id)
            live = clone(await this.owner.sessionQuery.readSession(agent.session.id))
          } catch { /* Unverifiable progress is not absence or corrupt snapshot storage. */ }
          if (!record.legacy && durable && live && matches(durable, record.checkpoint) && matches(live, record.checkpoint)) {
            state.record = record
            state.noticeState = record.notice ? 'pending' : 'none'
            return
          }
          state.quarantine = record
          state.recovery = { id: randomUUID(), phase: 'pending' }
          state.recoveryWarning = 'Session progress could not be verified; choose whether to retain the saved snapshot on your next idle user send.'
        } catch (error) { state.error = `Snapshot recovery failed: ${errorMessage(error)}` }
      })
      state.loaded = true
    })()
    await state.loading
  }
  async commit(state: SessionState, record: SnapshotRecord) {
    try { const saved = await this.store.save(record); if (state.disposed) this.store.forget(state.agent.session.id); state.record = saved ?? clone(record); state.error = null; state.captureError = null; state.noticeState = record.notice ? 'pending' : 'none' }
    catch (error) { state.error = `Snapshot persistence failed (commit may be uncertain): ${errorMessage(error)}. Review baseline before continuing.`; throw error }
  }
  async capture(options: GenerateOptions) {
    if (this.stopped) return
    const agent = options.sessionId ? this.owner.agents.get(options.sessionId) : undefined
    if (!agent) return
    const state = this.state(agent)
    await this.load(agent)
    await this.guardRecovery(state)
    if (this.stopped || state.record || state.error || options.signal?.aborted) return
    await this.store.serial(agent.session.id, async () => {
      if (this.stopped || state.record || state.error || options.signal?.aborted) return
      const mode = (this.owner.tools as unknown as { modeFor(agent: Agent): ToolMode }).modeFor(agent)
      const tools = options.tools ?? []
      let active, observation = null
      {
        let text: string | null = ''
        for (const system of options.messages.filter(message => message.role === 'system').reverse()) {
          const content = system.content
          text = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => (block as { text: string }).text).join('') : null
          if (text !== '') break
        }
        const matches = state.observations.filter(item => item.text === text && item.snapshot.mode === mode)
        const revisions = new Set(matches.map(item => mode === 'native' ? revision({ sections: item.snapshot.sections, sectionLayout: item.snapshot.sectionLayout }) : item.snapshot.revision))
        if (state.observationOverflow || revisions.size !== 1 || (mode !== 'native' && !matches[0].snapshot.sections.some(section => section.name === 'tools:sdk'))) {
          state.captureError = 'Cannot unambiguously correlate actual model system text with a non-probe assembly; snapshot remains inactive'
          if (state.recovery) this.failRecovery(state, new Error(state.captureError))
          return
        }
        if (matches.every(item => item.observation?.revision === matches[0].observation?.revision) && matches[0].observation) {
          const { revision: ignoredObservation, ...body } = clone(matches[0].observation)
          body.tools = clone(tools); observation = { ...body, revision: revision(body) }
        }
        const observed = matches[0].snapshot
        const { revision: ignored, ...body } = observed
        body.tools = clone(tools)
        if (mode === 'native') body.callables = clone(tools)
        active = { ...body, revision: revision(body) }
      }
      try {
        await this.commit(state, { format: 2, profileIdentity: this.store.profileIdentity, checkpoint: null, sessionId: agent.session.id, generation: (state.quarantine?.generation ?? 0) + 1, active, observation, registrationState: this.initialRegistration(active, agent), registrationOutbox: [], notice: null, kept: null })
        if (state.recovery?.phase === 'recapture') {
          if (this.stopped || state.disposed || options.signal?.aborted) this.failRecovery(state, new Error('Recovery cancelled after persistence; confirm the baseline again'))
          else this.finishRecovery(state, 'recaptured')
        }
        state.captureError = null
        state.candidate = active
        state.observations = []
      } catch (error) { if (state.recovery) this.failRecovery(state, error) /* Preserve this already-approved dispatch; no success outcome. */ }
    })
    this.scheduleCheckpoint(state)
  }
  // `delegationDepth` is the durable marker dsh-subagent persists on a child session header, and the
  // one its own cold-resume path trusts (dsh-subagent/lib/index.js delegationDepthOf).
  delegated(agent: Agent) { return (agent.session.header?.delegationDepth ?? 0) > 0 }
  async guardRecovery(state: SessionState, { signal, wait = false }: { signal?: AbortSignal; wait?: boolean } = {}) {
    if (!state.recovery || ['keep', 'recapture'].includes(state.recovery.phase)) return
    // Automatic keep for a delegated session: nobody can answer there, and a failed automatic attempt
    // marks the recovery so the next turn fails loudly instead of looping on the same decision.
    if (this.nonInteractive === 'auto-keep' && !state.recovery.autoBlocked && this.delegated(state.agent)) {
      state.recovery = { ...state.recovery, phase: 'keep', auto: true }
      return
    }
    // Turn paths hold and raise the prompt; non-turn paths (initial capture) keep failing fast so they
    // never stall on a decision only a user can make.
    if (wait) return await this.waitRecovery(state, signal ?? new AbortController().signal)
    throw new Error(state.recovery.error || 'Snapshot recovery requires a user choice on an idle send')
  }
  finishRecovery(state: SessionState, kind: string) {
    if (!state.recovery) return
    const auto = state.recovery?.auto === true
    state.recoveryOutcome = { id: state.recovery.id, kind: auto ? `auto-${kind}` : kind, auto, usageStatus: 'pending', ...(state.recoveryUsageResult?.id === state.recovery.id ? state.recoveryUsageResult : {}) }
    if (auto) this.bubbleChildRecovery(state)
    if (!state.recoveryUsage && state.recoveryOutcome.usageStatus === 'pending') Object.assign(state.recoveryOutcome, { usageStatus: 'not-called', usageReason: 'No matching recovery assembly was tracked' })
    state.recoveryWarning = state.quarantine?.notice || state.quarantine?.registrationOutbox?.length ? 'Historical pending notifications were discarded because delivery could not be verified; current missing registrations are checked afresh.' : null
    state.recovery = null; state.quarantine = null; state.deferredMessage = null
  }
  // A delegated session's automatic decision is otherwise visible only in that child's own panel. Record
  // it on the parent too, which is where the human is looking. Best effort: an unloaded parent is skipped.
  bubbleChildRecovery(state: SessionState) {
    const parent = this.childParents.get(state.agent.session.id)
    const target = parent === undefined ? undefined : this.states.get(parent.sessionId)
    if (!target || !parent || !state.recoveryOutcome) return
    const entry = { sessionId: state.agent.session.id, kind: state.recoveryOutcome.kind, label: parent.label }
    target.childRecoveries = [...(target.childRecoveries ?? []).filter(item => item.sessionId !== entry.sessionId), entry].slice(-4)
  }
  failRecovery(state: SessionState, error: unknown) {
    if (!state.recovery) return
    expireUsage(state, 'Recovery did not complete', true)
    state.recovery = { id: randomUUID(), phase: 'pending', error: errorMessage(error), ...(state.recovery.auto === true ? { autoBlocked: true } : {}) }
  }
  async waitRecovery(state: SessionState, signal: AbortSignal) {
    if (!state.recovery) return
    signal.throwIfAborted()
    // A normal send must not invalidate the pending choice already displayed by the panel.
    // A new hold after a cancelled wait still gets a fresh identity, as before.
    state.recovery = { id: state.recovery.phase === 'pending' ? state.recovery.id : randomUUID(), phase: 'awaiting-choice', ...(state.recovery.error ? { error: state.recovery.error } : {}) }
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new Error('Snapshot recovery cancelled; a new idle user send is required'))
        state.answerRecovery = resolve
        state.cancelRecovery = cancel
        signal.addEventListener('abort', cancel, { once: true })
        state.removeRecoveryAbort = () => signal.removeEventListener('abort', cancel)
        if (signal.aborted || state.disposed || this.stopped) cancel()
      })
      signal.throwIfAborted()
      if (this.stopped || state.disposed) throw new Error('Snapshot recovery stopped')
    } catch (error) {
      // An aborted turn must not drop the prompt: keep the same request answerable so the user can still
      // choose and the next send applies it. Other failures return to pending as before.
      if (signal.aborted) state.recovery = { ...state.recovery, phase: 'awaiting-choice', error: errorMessage(error) }
      else this.failRecovery(state, error)
    }
    finally {
      state.removeRecoveryAbort?.(); state.removeRecoveryAbort = null
      state.answerRecovery = null; state.cancelRecovery = null
    }
  }
  @Remote
  async resolveRecovery(id: SessionId, requestId: string, choice: RecoveryChoice) {
    if (!['keep', 'recapture'].includes(choice)) throw new Error('Invalid recovery choice')
    const state = this.state(this.agent(id))
    if (this.stopped || state.disposed || state.recovery?.id !== requestId || !['pending', 'awaiting-choice'].includes(state.recovery.phase)) throw new Error('Stale recovery request')
    // Memory only: without a held turn, the next real request applies this choice. Reloading
    // before that request must ask again, and repeated answers cannot replace the selection.
    state.recovery = { id: requestId, phase: choice }
    state.error = null; state.captureError = null; state.probeError = null
    state.observations = []; state.observationOverflow = false
    state.record = null
    state.answerRecovery?.()
    return clone(this.metadata(state))
  }
  initialRegistration(active: FrozenSnapshot, agent: Agent) {
    const current = registrationState(active, this.owner.tools, agent)
    const body = { version: 1, entries: current.entries.filter(e => e.registered) }
    return { ...body, revision: revision(body) }
  }
  scheduleCheckpoint(state: SessionState) {
    if (state.recovery || !state.loaded || !state.record || this.stopped || state.disposed) return
    state.checkpointDirty = true
    if (state.checkpointJob) return
    state.checkpointJob = (async () => {
      // Coalesce synchronous events, then yield between every pass. Never await
      // this job from a session/event or session/flush listener.
      try {
        do {
          await new Promise(resolve => setImmediate(resolve))
          if (this.stopped || state.disposed) return
          state.checkpointDirty = false
          await this.store.serial(state.agent.session.id, () => this.updateCheckpoint(state))
        } while (state.checkpointDirty)
      } catch (error) {
        state.checkpointError = errorMessage(error)
        // Retry only on a later event, not an unbounded failure loop.
        state.checkpointDirty = true
      } finally {
        // Clear synchronously with the final dirty check/error handler, so a
        // subsequent microtask event cannot land in a settled-but-owned job.
        state.checkpointJob = null
      }
    })()
  }
  async updateCheckpoint(state: SessionState) {
    if (state.recovery || !state.record || this.stopped || state.disposed || !this.owner.get('sessionPersistence')) return
    const cut = clone(await this.owner.sessionQuery.readSession(state.agent.session.id))
    const saved = checkpoint(cut)
    if (state.record.checkpoint?.hash === saved.hash) { state.checkpointError = null; return }
    if (!await this.owner.sessions.flush(state.agent.session) || !this.owner.get('sessionPersistence')) return
    const durable = await durableCut(this.owner, state.agent.session.id)
    if (!durable || !matches(durable, saved, false)) throw new Error('Durable session prefix did not match checkpoint cut')
    if (this.stopped || state.disposed) return
    const record = await this.store.saveCheckpoint(state.record, saved)
    if (state.disposed) { this.store.forget(state.agent.session.id); return }
    state.record = record ?? { ...state.record, checkpoint: saved }
    state.checkpointError = null
  }
  async probe(agent: Agent) {
    const state = this.state(agent), marker: { snapshot?: FrozenSnapshot; observation?: Observation } = {}
    const result = await this.owner.systemPrompt.assemble({ ...assembleContextFor(agent), [PROBE]: marker } as ReturnType<typeof assembleContextFor>)
    if (!marker.snapshot) throw new Error('Snapshot assemble hook was bypassed by another plugin')
    const snap = marker.snapshot
    const actual = snapshot(result, snap.callables, snap.mode, renderPrompt)
    if (JSON.stringify(actual.sections) !== JSON.stringify(snap.sections) || JSON.stringify(actual.sectionLayout) !== JSON.stringify(snap.sectionLayout) || (snap.mode !== 'native' && !actual.sections.some(s => s.name === 'tools:sdk'))) throw new Error('Unsupported complete/outer-hook section override: system prompt sections cannot be frozen in this composition')
    state.candidateAssembly = result
    state.candidate = snap
    state.observation = marker.observation
    state.probeError = null
    return snap
  }
  dirty() { for (const state of this.states.values()) { state.dirty = true; this.schedule(state.agent) } }
  schedule(agent: Agent) {
    const state = this.state(agent)
    if (state.recovery || !state.record || state.scheduled || state.busy || agent.status !== 'idle' || this.stopped) return
    state.scheduled = true
    queueMicrotask(async () => {
      try {
        // Bound reentrant producers: coalesce one additional pass, leave dirty for next status/assembly if still changing.
        for (let pass = 0; pass < 2 && !this.stopped && !state.busy && agent.status === 'idle'; pass++) {
          state.dirty = false
          await this.probe(agent)
          if (!state.dirty) break
        }
      }
      catch (error) { state.probeError = errorMessage(error) }
      finally { state.scheduled = false }
    })
  }
  async reconcile(agent: Agent) {
    const state = this.state(agent)
    if (state.recovery || !state.record?.notice) return
    return this.store.serial(agent.session.id, async () => {
      const record = state.record
      const notice = record?.notice
      if (!notice || !record) return
      const observed = await this.owner.sessionQuery.readSession(agent.session.id)
      const found = observed.events.some(e => e.seq >= observed.inheritedEventCount && e.type === 'user/message' && e.data.id === notice.message.id)
      if (!found) return
      const surface = await this.owner.sessionQuery.readSurface(agent.session.id)
      const present = surface.events.some(e => e.type === 'user/message' && e.data.id === notice.message.id)
      if (!present) {
        // The old notice may have been compacted before any model dispatch. Requeue a fresh message identity.
        const message = createUserMessage({ source: notice.message.source, content: notice.message.content })
        await this.commit(state, { ...record, generation: record.generation + 1, notice: { ...notice, message } })
        return false
      }
      // Explicitly await the WHOLE flush operation, never acknowledge from a parallel flush listener.
      const durable = await this.owner.sessions.flush(agent.session)
      if (!durable || !this.owner.get('sessionPersistence')) { state.noticeState = 'committed-not-durable'; return true }
      const afterFlush = await this.owner.sessionQuery.readSurface(agent.session.id)
      if (!afterFlush.events.some(e => e.type === 'user/message' && e.data.id === notice.message.id)) {
        const message = createUserMessage({ source: notice.message.source, content: notice.message.content })
        await this.commit(state, { ...record, generation: record.generation + 1, notice: { ...notice, message } })
        return false
      }
      await this.commit(state, { ...record, generation: record.generation + 1, notice: null })
      this.scheduleCheckpoint(state)
      state.noticeState = 'in-history'
      return true
    })
  }
  effectiveThreshold(state: SessionState) {
    if (state.settingsError || !state.settings) return null
    return state.settings.value === null ? this.thresholdTokens : parseThreshold(state.settings.value)
  }
  settingsMetadata(state: SessionState) {
    return { thresholdTokens: this.effectiveThreshold(state), settingsRevision: state.settings?.revision ?? 0, override: state.settings?.value ?? null, defaultThresholdTokens: this.thresholdTokens ?? null, ...(state.settingsError ? { settingsError: state.settingsError } : {}) }
  }
  autoMetadata(state: SessionState): AutoApplyMetadata { return { ...this.settingsMetadata(state), inputTokens: state.lastInputTokens ?? null, inputStale: state.lastInputTokens !== undefined, eligible: false } }
  @Remote
  async setAutoApply(id: SessionId, value: AutoApplySetting, expectedSettingsRevision: number) {
    validateSetting(value)
    const state = this.state(this.agent(id))
    await this.load(state.agent)
    await this.store.serial(id, async () => {
      if (this.stopped || state.disposed) throw new Error('Session settings are no longer available')
      try {
        state.settings = await this.settings.read(id)
        state.settingsError = null
        state.settings = await this.settings.set(id, value, expectedSettingsRevision)
        state.autoApply = this.autoMetadata(state)
      } catch (error) {
        if (!errorMessage(error).startsWith('Stale settings:') && !errorMessage(error).startsWith('Invalid settings revision')) state.settingsError = `Auto-apply settings failed: ${errorMessage(error)}`
        state.autoApply = this.autoMetadata(state)
        throw error
      }
    })
    // No probe, reconcile, Apply, or snapshot persistence on a settings update.
    return this.view(state)
  }
  // Diagnostics-only rebaseline: adopting every live-tagged entry closes those diffs. Frozen
  // sections keep their text, the frozen snapshot, generation, notices, registration state
  // and recovery state are untouched, and no notice message is inserted.
  @Remote
  async acknowledgeObservation(id: SessionId, expectedObservationRevision: string) {
    const state = this.state(this.agent(id))
    await this.load(state.agent)
    if (this.stopped || state.disposed) throw new Error('Session observations are no longer available')
    if (state.recovery) throw new Error('Resolve snapshot recovery first')
    await this.store.serial(id, async () => {
      if (this.stopped || state.disposed) throw new Error('Session observations are no longer available')
      const record = state.record
      const baseline = record?.observation
      if (!baseline || !record) throw new Error('No observation baseline to acknowledge')
      if (baseline.revision !== expectedObservationRevision) throw new Error('Stale observation baseline: refresh and review the current diagnostics again')
      await this.probe(state.agent)
      const next = rebaselineObservation(baseline, state.observation)
      if (!next) throw new Error('Observation baseline cannot be acknowledged')
      // Writing again would only rewrite identical content.
      const { revision: ignoredBaseline, ...baselineBody } = baseline
      const { revision: ignoredNext, ...nextBody } = next
      if (JSON.stringify(baselineBody) === JSON.stringify(nextBody)) return
      await this.commit(state, { ...record, observation: next })
    })
    return this.view(state)
  }
  recoveryMetadata(state: SessionState) {
    if (!state.recovery) return null
    const recovery = { ...state.recovery }
    // Display-only: read the optional live projection on every response, never cache it.
    if (recovery.phase === 'awaiting-choice') {
      try {
        const service = (typeof this.owner?.get === 'function' ? this.owner.get('sessionProjections') : null) as unknown as { snapshot?: (session: Agent['session'], keys: string[]) => { values?: { contextPressure?: { projectedTokens?: number } } } }
        if (typeof service?.snapshot === 'function') {
          const tokens = service.snapshot(state.agent.session, ['contextPressure'])?.values?.contextPressure?.projectedTokens
          if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) recovery.estimatedContextInputTokens = tokens
        }
      } catch { /* Optional projection failures must not affect recovery or auto-apply. */ }
      // Display-only, mirroring finishRecovery's kept-unchanged rule: does the live frozen
      // content still match the saved snapshot this choice is about?
      const saved = (state.record ?? state.quarantine)?.active?.revision
      if (saved && state.candidate?.revision) recovery.frozenContentMatches = saved === state.candidate.revision
    }
    // Bounded: the panel shows this so a cancelled turn's message can be copied and resent.
    if (state.deferredMessage?.text) recovery.deferredMessage = { text: state.deferredMessage.text.slice(0, 2000) }
    return recovery
  }
  metadata(state: SessionState) {
    return { sessionId: state.agent.session.id, generation: (state.record ?? state.quarantine)?.generation ?? 0,
      recovery: this.recoveryMetadata(state), recoveryOutcome: state.recoveryOutcome ?? null,
      autoApply: { ...this.autoMetadata(state), ...state.autoApply, ...this.settingsMetadata(state) },
      busy: state.busy || state.agent.status !== 'idle', error: state.error || state.captureError || state.probeError || state.noticeError,
      errors: { storage: state.error, probe: state.probeError, notice: state.noticeError },
      recoveryWarning: state.recoveryWarning, checkpointError: state.checkpointError,
      // Automatic keeps taken in delegated sessions of this one, newest last (best effort).
      childRecoveries: state.childRecoveries ?? null,
      registrationError: state.registrationError ?? null, registrationPending: state.record?.registrationOutbox?.length ?? 0,
      upgradeRequired: !!state.record && !expandedCoverage(state.record.active), baselineRequired: !!state.error, awaitingFirstCall: !state.record && !state.error,
      noticeState: state.noticeState, compatibility: 'Outer assembly/pre-step hooks can override or bypass this plugin. Tool implementations and cache hits are not frozen.',
      delegated: this.delegated(state.agent) }
  }
  view(state: SessionState) {
    return clone({ ...this.metadata(state), active: (state.record ?? state.quarantine)?.active ?? null, candidate: state.candidate,
      observation: { baseline: state.record?.observation ?? null, current: state.observation ?? null, diff: observationDiff(state.record?.observation, state.observation), baselineAvailable: !!state.record?.observation },
      diff: state.candidate ? diff(state.record?.active, state.candidate) : null, kept: state.record?.kept ?? null })
  }
  async refreshStatus(id: SessionId) {
    const agent = this.agent(id), state = this.state(agent)
    await this.load(agent)
    if (!state.recovery && !state.busy && agent.status === 'idle') {
      try { await this.probe(agent) } catch (error) { state.probeError = errorMessage(error) }
      try { await this.reconcile(agent); state.noticeError = null } catch (error) { state.noticeError = errorMessage(error) }
    }
    if (!state.recovery && !state.busy && agent.status === 'idle') this.estimateAuto(state)
    else state.autoApply = this.autoMetadata(state)
    return state
  }
  @Remote
  async status(id: SessionId) { return this.view(await this.refreshStatus(id)) }
  // Display-only tag for the compact summary: which live-tagged entries differ from the
  // saved observation baseline. Frozen differences stay Apply-only and are not listed here.
  liveChanges(state: SessionState) {
    const baseline = state.record?.observation, current = state.observation
    if (!baseline?.revision || !current?.revision) return null
    const observed = observationDiff(baseline, current)
    const result: Partial<Record<ObservationUnit, { count: number; names: string[]; orderChanged?: boolean }>> = {}
    if (!observed) return null
    for (const unit of ['sections', 'contexts', 'variables'] as const) {
      const rows = [...observed[unit].added, ...observed[unit].removed, ...observed[unit].changed].filter(row => isLiveObservationRow(unit, row))
      const orderChanged = DIAGNOSTIC_UNITS.includes(unit) && observed[unit].orderChanged
      if (!rows.length && !orderChanged) continue
      const names = rows.map(row => String(row.name).slice(0, 160))
      result[unit] = { count: names.length, names: names.slice(0, 20), ...(orderChanged ? { orderChanged: true } : {}) }
    }
    return Object.keys(result).length ? result : null
  }
  @Remote
  async summary(id: SessionId) {
    const state = await this.refreshStatus(id)
    return clone({ ...this.metadata(state), active: state.record?.active ? { revision: state.record.active.revision } : null,
      candidate: state.candidate ? { revision: state.candidate.revision } : null, liveChanges: this.liveChanges(state) })
  }
  @Remote
  async applySnapshot(id: SessionId, expectedRevision: string, expectedGeneration: number, baseline: boolean) {
    const agent = this.agent(id), state = this.state(agent)
    // This claim is synchronous, before the first await. Public idle also includes maintenance.
    return agent.runMaintenance(async signal => {
      state.busy = true
      try {
        await this.load(agent)
        if (state.recovery) throw new Error('Resolve snapshot recovery first')
        return await this.store.serial(id, async () => {
        const current = await this.probe(agent)
        signal.throwIfAborted()
        if (current.revision !== expectedRevision || (state.record?.generation ?? 0) !== expectedGeneration) throw new Error('Stale review: refresh and review the current candidate again')
        if (!state.record && !state.error) throw new Error('Waiting for the first model API call')
         if (state.error && !baseline) throw new Error('Explicit baseline confirmation required')
        if (state.record && !state.error && state.record.active.revision === current.revision) return this.view(state)
        await this.commit(state, this.prepareApply(state, current))
        return this.view(state)
        })
      } finally { state.busy = false; this.scheduleCheckpoint(state) }
    })
  }
  autoInserted(agent: Agent, message: UserMessage) {
    const state = this.state(agent)
    if (message.source?.kind !== 'user' || agent.status !== 'idle' || state.busy || this.stopped) return
    try { state.autoJob = agent.runMaintenance(async signal => {
      state.busy = true
      try {
        await this.load(agent)
        if (state.recovery) {
          // The turn's own assembly holds the request and raises the prompt (or takes the automatic keep
          // for a delegated session), so this pass stops here rather than competing for one request id.
          this.dirty()
          return
        }
        await this.store.serial(agent.session.id, async () => {
          signal.throwIfAborted()
          if (this.effectiveThreshold(state) === null || !state.record || !expandedCoverage(state.record.active) || state.error || state.captureError || state.noticeError || state.disposed || this.stopped) return
          const current = await this.probe(agent)
          signal.throwIfAborted()
          if (state.record.active.revision === current.revision) return
          const batch = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
          if (!batch.some(m => m.id === message.id && m.source?.kind === 'user')) return
          const prepared = this.prepareApply(state, current, true)
          const estimate = this.estimateAuto(state, batch, prepared.notice.message)
          signal.throwIfAborted()
          if (!estimate.eligible || this.stopped || state.disposed) return
          await this.commit(state, prepared)
        })
      } catch (error) { state.autoApply = { ...this.autoMetadata(state), error: errorMessage(error) } }
      finally { state.busy = false; this.scheduleCheckpoint(state) }
    }).catch(error => { state.autoApply = { ...this.autoMetadata(state), error: errorMessage(error) } })
    } catch { /* Another maintenance owner has already reserved this idle agent. */ }
  }
  estimateAuto(state: SessionState, batch?: UserMessage[], notice?: UserMessage) {
    const result = this.autoMetadata(state)
    const threshold = result.thresholdTokens
    try {
      if (!state.recovery && state.candidate && state.record && !state.error && !state.probeError) {
        batch ??= [...(state.agent.inbox?.nextStep ?? []), ...(state.agent.inbox?.nextTurn ?? [])]
        notice ??= threshold !== null && state.record.active.revision !== state.candidate.revision ? this.prepareApply(state, state.candidate, true).notice.message : state.record.notice?.message
        const registration = registrationState(state.candidate, this.owner.tools, state.agent)
        if (state.record.registrationOutbox?.length || registration.entries.some(e => !e.registered) || state.record.registrationState?.entries.some(e => !e.registered && registration.entries.some(n => n.name === e.name && n.registered))) throw new Error('Pending registration notification cannot be estimated safely')
        result.inputTokens = estimateInput(state.agent, state.candidateAssembly, batch, notice)
        state.lastInputTokens = result.inputTokens
        result.inputStale = false
        result.eligible = expandedCoverage(state.record.active) && threshold !== null && result.inputTokens < threshold && state.record.active.revision !== state.candidate.revision && !state.captureError && !state.noticeError
      }
    } catch (error) { result.error = errorMessage(error) }
    state.autoApply = result
    return result
  }
  prepareApply(state: SessionState, current: FrozenSnapshot, automatic = false) {
        const from = state.record?.notice?.from ?? state.record?.active ?? null
        const fullDiff = diff(from, current)
        const changes = { sections: { ...Object.fromEntries((['added', 'removed', 'changed'] as const).map(key => [key, fullDiff.sections[key].slice(0, 50).map(s => s.name.slice(0, 160))])), counts: Object.fromEntries((['added', 'removed', 'changed'] as const).map(key => [key, fullDiff.sections[key].length])), orderChanged: fullDiff.sections.orderChanged }, coverageChanged: fullDiff.coverageChanged, added: fullDiff.added.slice(0, 50).map(name => name.slice(0, 160)), removed: fullDiff.removed.slice(0, 50).map(name => name.slice(0, 160)), changed: fullDiff.changed.slice(0, 50).map(({ name, fields }) => ({ name: name.slice(0, 160), fields })), counts: { added: fullDiff.added.length, removed: fullDiff.removed.length, changed: fullDiff.changed.length }, orderChanged: fullDiff.orderChanged, sdkChanged: fullDiff.sdkChanged, modeChanged: fullDiff.modeChanged }
        const message = createUserMessage({ source: { kind: SOURCE_KIND, form: 'notice', summary: automatic ? 'Automatically applied under user-configured token threshold' : 'User applied tool declaration and system prompt section changes' }, content: [{ type: 'text', text: `${automatic ? 'The user-configured automatic policy applied' : 'The user confirmed'} tool declaration snapshot ${current.revision}. Use the tool declarations and system prompt sections supplied with this request. Changes: ${JSON.stringify(changes)}. Tool implementations, permissions, runtime contexts and excluded live sections remain live.` }] })
        return { ...state.record, format: 2, profileIdentity: this.store.profileIdentity, checkpoint: state.record?.checkpoint ?? null, sessionId: state.agent.session.id, generation: (state.record?.generation ?? 0) + 1, active: current, observation: state.observation, notice: { from, message }, kept: null }
  }
  @Remote
  async keep(id: SessionId, expectedRevision: string, expectedGeneration: number) {
    const agent = this.agent(id), state = this.state(agent)
    return agent.runMaintenance(async () => {
      state.busy = true
      try {
        await this.load(agent)
        if (state.recovery) throw new Error('Resolve snapshot recovery first')
        return await this.store.serial(id, async () => {
        const candidate = await this.probe(agent)
        if (!state.record || state.error) throw new Error('Establish a baseline first')
        if (candidate.revision !== expectedRevision || state.record.generation !== expectedGeneration) throw new Error('Stale review')
        await this.commit(state, { ...state.record, generation: state.record.generation + 1, kept: candidate.revision })
        return this.view(state)
        })
      } finally { state.busy = false; this.scheduleCheckpoint(state) }
    })
  }
}
