// Isolated benchmark only. Run: node --expose-gc bench/performance.mjs [output.json]
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir, cpus, platform, release } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import Prompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { PromptFreeze } from '../lib/host.mjs'
import { snapshot, observe, project, diff, observationDiff, clone, Store, validateRecord } from '../lib/core.mjs'
import { checkpoint, matches } from '../lib/recovery.mjs'
import { dshInternal } from '../test/dsh-internal.mjs'
const { default: Persistence } = await dshInternal('@deepseek-ai/dsh-session-persistence-jsonl')
const started = performance.now(), root = await mkdtemp(join(tmpdir(), 'prompt-freeze-perf-'))
const bytes = v => Buffer.byteLength(JSON.stringify(v))
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { iterations: values.length, medianMs: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null, p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, totalMs: values.reduce((a, b) => a + b, 0), samplesMs: values }
}
async function measure(fn, iterations = 20, warmups = 3) {
  for (let i = 0; i < warmups; i++) await fn()
  globalThis.gc?.()
  const times = []; let value
  for (let i = 0; i < iterations; i++) { const start = performance.now(); value = await fn(); times.push(performance.now() - start) }
  return { warmups, ...summarize(times), resultJsonBytes: value === undefined ? 0 : bytes(value) }
}
function assembly(count, size) {
  return { tools: Array.from({ length: count }, (_, i) => ({ name: `bench_${i}`, description: 'Synthetic tool documentation. '.repeat(Math.ceil(size / 30)).slice(0, size - 180), parameters: { type: 'object', properties: { input: { type: 'string', description: 'Synthetic input' } }, required: ['input'] } })),
    sections: [...Array.from({ length: 20 }, (_, i) => ({ name: `managed:${i}`, text: `Section ${i} {{bench_value}} ` + 's'.repeat(1000) })), { name: 'plan:policy', text: 'Live policy {{bench_value}}' }, { name: 'harness:identity', text: 'Synthetic harness' }],
    contexts: [{ name: 'runtime:policy', text: 'Live context {{bench_value}} ' + 'c'.repeat(1024) }, { name: 'runtime:working', text: 'Isolated synthetic working context' }], variables: { bench_value: 'benchmark' } }
}
function record(store, active, observation) { return { format: 2, profileIdentity: store.profileIdentity, sessionId: 'bench', generation: 1, active, observation, checkpoint: null, notice: null, kept: null } }
function cutFor(count) {
  return { session: { id: 'bench', createdAt: 1700000000000, delegationDepth: 0 }, inheritedEventCount: 0,
    events: Array.from({ length: count }, (_, seq) => ({ seq, time: 1700000000000 + seq, type: seq % 2 ? 'assistant/message' : 'user/message', data: { id: `message-${seq}`, role: seq % 2 ? 'assistant' : 'user', ...(seq % 2 ? {} : { source: { kind: 'user' } }), content: [{ type: 'text', text: 'Synthetic event payload. '.repeat(45).slice(0, 1024) }] } })) }
}
// Instance-only wrappers: no global/prototype patches. Timing excludes byte accounting.
function instrument(object, name, counters, label = name, byteArg = false) {
  const original = object[name].bind(object)
  object[name] = async (...args) => {
    const start = performance.now()
    try { return await original(...args) } finally {
      const elapsed = performance.now() - start
      const c = counters[label] ??= { calls: 0, bytes: 0, samplesMs: [] }
      c.calls++; c.samplesMs.push(elapsed); if (byteArg) c.bytes += bytes(args[0])
    }
  }
}
function counterSnapshot(counters) { return Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, { calls: v.calls, bytes: v.bytes, ...summarize(v.samplesMs) }])) }
class Adapter extends LlmAdapter {
  constructor(steps) { super(); this.steps = steps; this.phase = 0; this.requests = 0; this.executions = 0 }
  providerInfo(provider) { return { id: provider, name: provider } }
  async *stream() {
    this.requests++
    if (this.phase++ < this.steps) {
      const id = `call-${this.requests}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'bench_0', argumentsDelta: '{"input":"synthetic"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bench_0', arguments: '{"input":"synthetic"}' } }
      yield { type: 'finish', reason: 'tool-calls' }
    } else {
      this.phase = 0
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}
class Query extends SessionQueryEngine { async searchSessions() { throw Error('unused') } async searchEvents() { throw Error('unused') } }
async function fixture(enabled, steps) {
  const ctx = new Context(), adapter = new Adapter(steps), counters = {}
  let eventCount = 0
  ctx.on('session/event', (session, event) => { if (session.id === 'bench') eventCount = Math.max(eventCount, event.seq + 1) })
  try {
    await ctx.plugin(Prompt, {}); await ctx.plugin(Tools, { mode: 'native' }); await ctx.plugin(Agents); await ctx.plugin(Sessions)
    await ctx.plugin(Persistence, { root: await mkdtemp(join(root, 'jsonl-')), compression: 'none' })
    await ctx.plugin(Projections); await ctx.plugin(Llm); ctx.llm.registerAdapter(['bench'], adapter)
    await ctx.plugin(Query); await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 })
    for (const schema of assembly(12, 1024).tools) ctx.tools.register({ ...schema, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => { adapter.executions++; return 'synthetic output' } })
    instrument(ctx.sessions, 'flush', counters)
    instrument(ctx.sessionQuery, 'readSession', counters); instrument(ctx.sessionQuery, 'readSurface', counters)
    instrument(ctx.sessionPersistence, 'open', counters, 'persistence.open')
    if (enabled) await ctx.plugin(PromptFreeze, { directory: await mkdtemp(join(root, 'guard-')) })
    const host = enabled ? ctx.promptFreeze : null
    if (host) {
      instrument(host.store, 'save', counters, 'store.save', true)
      if (host.store.saveCheckpoint) instrument(host.store, 'saveCheckpoint', counters, 'store.saveCheckpoint')
      for (const name of ['capture', 'updateCheckpoint', 'probe', 'status']) instrument(host, name, counters)
    }
    const agent = await ctx.agentLoop.create('bench', { provider: 'bench', model: 'bench' })
    return { ctx, adapter, host, agent, counters, eventCount: () => eventCount, close: () => ctx.fiber.dispose() }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
async function settle(f, force = true) {
  const deadline = performance.now() + 10000
  for (;;) {
    await new Promise(resolve => setImmediate(resolve))
    const s = f.host?.state(f.agent)
    if (s?.checkpointJob) await s.checkpointJob
    if (f.host) await Promise.all([...f.host.store.queues.values()])
    if (force && s?.checkpointDirty && !s.checkpointJob) {
      const counter = f.counters.forcedDrainReschedules ??= { calls: 0, bytes: 0, samplesMs: [] }
      counter.calls++; f.host.scheduleCheckpoint(s)
    }
    if (!s || (!s.scheduled && !s.checkpointJob && (!force || !s.checkpointDirty) && !f.host.store.queues.size)) break
    if (performance.now() > deadline) throw Error('Fixture queues did not settle')
  }
  const s = f.host?.state(f.agent)
  if (s) { assert.equal(s.checkpointError, null); assert.equal(s.captureError, null); assert.equal(s.error, null) }
}
function progressSnapshot(f, baseline) {
  const state = f.host?.state(f.agent)
  return { callsSinceSend: Object.fromEntries(Object.entries(f.counters).map(([name, c]) => [name, c.calls - (baseline[name] ?? 0)])), checkpointDirty: state?.checkpointDirty ?? false, checkpointJobPending: !!state?.checkpointJob, checkpointCount: state?.record?.checkpoint?.count ?? null, eventCount: f.eventCount() }
}
const integrationOnly = process.env.PROMPT_FREEZE_PERF_INTEGRATION_ONLY === '1'
const results = { integrationOnly, environment: { node: process.version, v8: process.versions.v8, platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, cpuCount: cpus().length, gcExposed: !!globalThis.gc, tempRoot: root, execArgv: process.execArgv }, methodology: { timeUnit: 'milliseconds', percentiles: 'nearest-rank p95; midpoint median', gc: 'before each microbenchmark measurement series, not within samples', durability: 'Production Store.save file fsync, rename and directory fsync unchanged. No-op is comparison baseline only.', integration: 'Real Context/AgentLoop/Tools/SessionQuery/JSONL, native mode, fake in-process LlmAdapter, no network; one fixture per on/off/step case; repeated genuine user inputs; instance method wrappers include queue waits in capture timing; settled latency includes explicit equal flush barrier in both cases.', state: 'Only newly created OS mkdtemp directories; removed after disposal', settlement: 'Each sample snapshots completed call counts, observed session event count, checkpoint count and dirty flag at whenIdle, then awaits only existing jobs/queues/probes for natural drain (no checkpoint scheduling), then forces drain. Counters increment on method completion. Forced drain explicitly reschedules leftover checkpointDirty; forcedDrainReschedules counts this extra benchmark work. No queues carried across samples.', filesystemCaveat: 'Temporary filesystem timings are not predictions for production ext4; no live state/profile accessed.', instrumentation: 'Instance timing wrappers and post-save JSON byte accounting perturb timings; store.save time excludes byte accounting, enclosing request time includes it.' }, core: [], history: [], integration: [] }
try {
  for (const [count, size] of integrationOnly ? [] : [[30, 1024], [100, 2048], [300, 4096]]) {
    const a = assembly(count, size), snap = snapshot(a, a.tools, 'native', renderPrompt), obs = observe(a, renderPrompt, renderContextSections)
    const changed = clone(a); changed.tools[0].parameters.properties.input.maxLength = 200
    const next = snapshot(changed, changed.tools, 'native', renderPrompt)
    const store = new Store(await mkdtemp(join(root, 'store-'))), rec = record(store, snap, obs)
    validateRecord(rec, 'bench', store.profileIdentity)
    const operations = {}
    for (const [name, fn] of Object.entries({ snapshot: () => snapshot(a, a.tools, 'native', renderPrompt), observe: () => observe(a, renderPrompt, renderContextSections), project: () => project(a, snap), diffUnchanged: () => diff(snap, snap), diffOneSchemaChange: () => diff(snap, next), observationDiffUnchanged: () => observationDiff(obs, obs), renderPrompt: () => renderPrompt(a), renderContextSections: () => renderContextSections(a) })) operations[name] = await measure(fn)
    const viewState = { agent: { session: { id: 'bench' }, status: 'idle' }, record: rec, candidate: snap, observation: obs }
    operations.viewUnchanged = await measure(() => PromptFreeze.prototype.view.call(PromptFreeze.prototype, viewState))
    operations.statusResponseJsonEncode = await measure(() => JSON.stringify(PromptFreeze.prototype.view.call(PromptFreeze.prototype, viewState)))
    operations.statusResponseJsonEncode.rawResponseBytes = bytes(PromptFreeze.prototype.view.call(PromptFreeze.prototype, viewState))
    if (PromptFreeze.prototype.summary) {
      const summaryHost = { metadata: PromptFreeze.prototype.metadata, async refreshStatus() { return viewState } }
      operations.summaryProjectionOnly = await measure(() => PromptFreeze.prototype.summary.call(summaryHost, 'bench'))
    }
    operations.storeSaveRealFsync = await measure(() => store.save(rec), 8, 2)
    operations.storeSaveNoopBaseline = await measure(async () => {}, 8, 2)
    results.core.push({ tools: count, targetBytesPerTool: size, toolsJsonBytes: bytes(a.tools), assemblyJsonBytes: bytes(a), snapshotJsonBytes: bytes(snap), observationJsonBytes: bytes(obs), recordJsonBytes: bytes(rec), fileBytes: (await stat(store.path('bench'))).size, managedSections: 20, liveSections: 2, contexts: 2, operations })
  }
  for (const count of integrationOnly ? [] : [100, 1000, 10000]) {
    const cut = cutFor(count), saved = checkpoint(cut), a = assembly(30, 1024), active = snapshot(a, a.tools, 'native', renderPrompt)
    const operations = {}, n = count === 10000 ? 5 : 12
    for (const [name, fn] of Object.entries({ cloneCut: () => clone(cut), checkpoint: () => checkpoint(cut), matches: () => matches(cut, saved), checkpointPlusMatches: () => matches(cut, checkpoint(cut)), cloneCheckpointPlusMatches: () => { const c = clone(cut); return matches(c, checkpoint(c)) } })) operations[name] = await measure(fn, n, 2)
    // Isolated synthetic query/persistence adapter, production updateCheckpoint method.
    for (const realSave of [false, true]) {
      const store = new Store(await mkdtemp(join(root, 'update-')))
      let current = clone(cut), flushCalls = 0, saveCalls = 0
      const persistence = { async open() { return { header: current.session, inheritedEventCount: 0, async read() { return { events: current.events } }, async close() {} } } }
      const host = { stopped: false, store: realSave ? store : { async save() { saveCalls++ }, async saveCheckpoint(record, checkpoint) { saveCalls++; return { ...record, checkpoint } } }, owner: { get: () => persistence, sessionQuery: { async readSession() { return current } }, sessions: { async flush() { flushCalls++; return true } } } }
      const state = { agent: { session: { id: 'bench' } }, record: { ...record(store, active), checkpoint: saved } }
      const label = realSave ? 'syntheticQueryPersistence_realStore' : 'syntheticQueryPersistence_noopStore'
      operations[`${label}_sameProgress`] = await measure(() => PromptFreeze.prototype.updateCheckpoint.call(host, state), n, 2)
      operations[`${label}_changedProgress`] = await measure(() => { current.events.at(-1).time++; return PromptFreeze.prototype.updateCheckpoint.call(host, state) }, n, 2)
      operations[`${label}_changedProgress`].flushCallsIncludingWarmups = flushCalls
      operations[`${label}_changedProgress`].noopSaveCallsIncludingWarmups = saveCalls
      current = cut
    }
    results.history.push({ eventCount: count, payloadBytesPerEvent: 1024, cutJsonBytes: bytes(cut), operations })
  }
  for (const steps of [0, 2]) for (const enabled of [false, true]) {
    const f = await fixture(enabled, steps)
    try {
      const idle = [], natural = [], settled = [], samples = []
      const send = async index => {
        await settle(f)
        const requestsBefore = f.adapter.requests, executionsBefore = f.adapter.executions
        const callsBefore = Object.fromEntries(Object.entries(f.counters).map(([name, c]) => [name, c.calls]))
        const t = performance.now()
        f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Benchmark genuine user request ${index}` }] }))
        await f.agent.whenIdle(); const idleMs = performance.now() - t
        const atWhenIdle = progressSnapshot(f, callsBefore)
        await settle(f, false)
        const naturallyDrainedMs = performance.now() - t
        const atNaturalDrain = progressSnapshot(f, callsBefore)
        await settle(f); await f.ctx.sessions.flush(f.agent.session); await settle(f)
        const settledMs = performance.now() - t
        const atForcedDrainAndFlush = progressSnapshot(f, callsBefore)
        assert.equal(f.adapter.requests - requestsBefore, steps + 1)
        assert.equal(f.adapter.executions - executionsBefore, steps)
        if (f.host) { const s = f.host.state(f.agent); assert(s.record); assert(matches(await f.ctx.sessionQuery.readSession('bench'), s.record.checkpoint)) }
        return { idleMs, naturallyDrainedMs, settledMs, atWhenIdle, atNaturalDrain, atForcedDrainAndFlush }
      }
      const firstCaptureSample = await send('warmup-0')
      const firstCaptureCounters = counterSnapshot(f.counters)
      await send('warmup-1')
      for (const key of Object.keys(f.counters)) delete f.counters[key]
      const beforeRequests = f.adapter.requests, beforeExecutions = f.adapter.executions
      for (let i = 0; i < 8; i++) { const sample = await send(i); idle.push(sample.idleMs); natural.push(sample.naturallyDrainedMs); settled.push(sample.settledMs); samples.push(sample) }
      const requestCounters = counterSnapshot(f.counters)
      const diagnostic = {}
      if (f.host) {
        const state = f.host.state(f.agent), before = JSON.stringify(state.record)
        diagnostic.probe = await measure(async () => { const value = await f.host.probe(f.agent); await settle(f); return value }, 8, 2)
        diagnostic.statusUnchanged = await measure(async () => { const value = await f.host.status('bench'); await settle(f); return value }, 8, 2)
        if (f.host.summary) diagnostic.summaryUnchanged = await measure(async () => { const value = await f.host.summary('bench'); await settle(f); return value }, 8, 2)
        diagnostic.view = await measure(() => f.host.view(state), 12, 2)
        diagnostic.statusJsonEncode = await measure(() => JSON.stringify(f.host.view(state)), 12, 2)
        assert.equal(JSON.stringify(state.record), before, 'Unchanged diagnostics must not mutate saved record')
        diagnostic.noRecordChanges = true
        let releaseBarrier, enteredBarrier
        const hold = new Promise(resolve => { releaseBarrier = resolve })
        const entered = new Promise(resolve => { enteredBarrier = resolve })
        const blocker = f.host.store.serial('bench', async () => { enteredBarrier(); await hold })
        await entered
        const startBarrier = performance.now()
        const timer = setTimeout(releaseBarrier, 20)
        let captureElapsedMs
        try { await f.host.capture({ sessionId: 'bench' }); captureElapsedMs = performance.now() - startBarrier; await blocker }
        finally { clearTimeout(timer); releaseBarrier() }
        diagnostic.activeCaptureControlledQueueBarrier = { requestedHoldMs: 20, elapsedMs: captureElapsedMs, barrierTotalMs: performance.now() - startBarrier, syntheticContention: true }
        await settle(f)
      }
      results.integration.push({ pluginEnabled: enabled, mode: 'native', tools: 12, toolStepsPerUserRequest: steps, warmups: 2, genuineUserRequests: 8, llmDispatches: f.adapter.requests - beforeRequests, toolExecutions: f.adapter.executions - beforeExecutions, whenIdle: summarize(idle), naturallyDrained: summarize(natural), settledCheckpointAndFlush: summarize(settled), samples, firstCaptureSample, firstCaptureCounters, requestCounters, diagnostics: diagnostic, allCountersIncludingDiagnostics: counterSnapshot(f.counters), finalEventCount: (await f.ctx.sessionQuery.readSession('bench')).events.length })
    } finally { await settle(f); await f.close() }
  }
  results.elapsedMs = performance.now() - started
} finally {
  // Verify deletion target is exactly the mkdtemp-owned direct child of tmpdir.
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(root.startsWith(join(tmpdir(), 'prompt-freeze-perf-')))
  await rm(root, { recursive: true, force: true })
}
const json = JSON.stringify(results, null, 2) + '\n'
if (process.argv[2]) await writeFile(resolve(process.argv[2]), json)
process.stdout.write(json)
