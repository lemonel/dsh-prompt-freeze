import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Prompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { PromptFreeze } from '../lib/host.mjs'
import { prepareRegistration } from '../lib/registration.mjs'
import { Store, diff, revision, LIVE_SECTION_NAMES } from '../lib/core.mjs'
import { dshInternal, dshPlugin } from './dsh-internal.mjs'

const root = await mkdtemp(join(tmpdir(), 'prompt-freeze-tests-'))
await mkdir(root, { recursive: true })
async function directory() { return mkdtemp(join(root, 'case-')) }
function tool(name, description = name, parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => name }
}
class Adapter extends LlmAdapter {
  constructor() { super(); this.requests = []; this.wait = null }
  providerInfo(provider) { return { id: provider, name: provider } }
  async *stream(options) {
    this.requests.push(options)
    if (this.wait) await this.wait
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'OK' }
    yield { type: 'block-end', index: 0 }
    yield { type: 'finish', reason: 'stop' }
  }
}
async function fixture(mode = 'native', stateDir, beforeHost, persistenceRoot, resume = false) {
  const ctx = new Context(), adapter = new Adapter()
  await ctx.plugin(Prompt, {})
  if (mode !== 'native') ctx.provide('ptcRuntime', { language: 'typescript' })
  await ctx.plugin(Tools, { mode })
  await ctx.plugin(Agents)
  await ctx.plugin(Sessions)
  if (persistenceRoot) {
    const Persistence = await dshPlugin('@deepseek-ai/dsh-session-persistence-jsonl')
    await ctx.plugin(Persistence, { root: persistenceRoot, compression: 'none' })
  }
  await ctx.plugin(Projections)
  await ctx.plugin(Llm)
  ctx.llm.registerAdapter(['test'], adapter)
  // Real query engine reads live sessions. Only search is unused.
  const { SessionQueryEngine } = await import('@deepseek-ai/dsh-session-query')
  class Query extends SessionQueryEngine { async searchSessions() { throw new Error('unused') }; async searchEvents() { throw new Error('unused') } }
  await ctx.plugin(Query)
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 })
  const release = ctx.tools.register(tool('alpha'))
  await beforeHost?.(ctx)
  const hostFiber = await ctx.plugin(PromptFreeze, { directory: stateDir ?? await directory(), autoApplyBelow: '' })
  const host = ctx.promptFreeze
  const agent = resume ? (await ctx.agentLoop.resume(ctx, { resumeSessionId: 'session-test', agentOptions: { provider: 'test', model: 'test' } })).agent : await ctx.agentLoop.create('session-test', { provider: 'test', model: 'test' })
  return { ctx, agent, adapter, host, hostFiber, release, async close() { await ctx.fiber.dispose() } }
}
const send = async (f, text = 'hello') => { f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await f.agent.whenIdle() }
const assemble = f => f.ctx.systemPrompt.assemble(assembleContextFor(f.agent))
// The host's tool-mode enum is not fixed across DSH versions: 'both' existed in 0.1.7/0.2.0 but is
// rejected in 0.2.1-alpha.x. Parameterize over the modes this host actually accepts, so the suite stays
// green on every supported line instead of reporting four phantom failures on the newer one. The probe
// reproduces fixture()'s own prefix — Prompt, then the ptc runtime, then Tools — because loading Tools
// alone accepts any mode (the enum is validated on the assembly side), so a Tools-only probe would
// silently claim support that the fixture does not have.
const MODES = []
for (const mode of ['native', 'ptc', 'both']) {
  const probe = new Context()
  try {
    await probe.plugin(Prompt, {})
    if (mode !== 'native') probe.provide('ptcRuntime', { language: 'typescript' })
    await probe.plugin(Tools, { mode })
    MODES.push(mode)
  } catch { /* this host rejects the mode */ }
  finally { await probe.fiber?.dispose?.().catch(() => {}) }
}
test('real registry no-op preparation skips history, surface and commit with empty outbox', async () => {
  const f = await fixture()
  try {
    await send(f)
    const state = f.host.state(f.agent)
    await state.checkpointJob
    const query = f.ctx.sessionQuery
    const readSession = query.readSession, readSurface = query.readSurface, commit = f.host.commit
    try {
      query.readSession = () => assert.fail('unexpected history read')
      query.readSurface = () => assert.fail('unexpected surface read')
      f.host.commit = () => assert.fail('unexpected registration commit')
      assert.equal(await f.host.store.serial(f.agent.session.id, () => prepareRegistration(f.host, state)), null)
    } finally { query.readSession = readSession; query.readSurface = readSurface; f.host.commit = commit }
  } finally { await f.close() }
})

const registrationEvents = async f => (await f.ctx.sessionQuery.readSession(f.agent.session.id)).events.filter(e => e.type === 'user/message' && e.data.source?.form === 'registration')

for (const mode of MODES) test(`${mode}: independent registration notices retain frozen surface and report final net changes`, async () => {
  const f = await fixture(mode)
  try {
    await send(f)
    const baseline = structuredClone(f.host.state(f.agent).record.registrationState)
    const releaseBeta = f.ctx.tools.register(tool('beta'))
    let review = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    const applied = structuredClone(f.host.state(f.agent).record)
    assert.deepEqual(applied.registrationState, baseline)
    const frozen = await assemble(f)
    releaseBeta()
    await f.host.status(f.agent.session.id)
    assert.deepEqual(f.host.state(f.agent).record.registrationState, baseline)
    await send(f)
    const events = await registrationEvents(f)
    assert.equal(events.length, 1)
    assert.equal(events[0].data.source.kind, 'prompt-freeze')
    assert.equal(applied.notice.message.source.kind, 'prompt-freeze')
    assert.match(events[0].data.content[0].text, /unavailable.*beta/)
    assert(f.adapter.requests.at(-1).messages.some(m => m.id === applied.notice.message.id))
    assert.deepEqual((await assemble(f)).sections, frozen.sections)
    assert.deepEqual((await assemble(f)).tools, frozen.tools)
    await send(f)
    assert.equal((await registrationEvents(f)).length, 1)
    const beta = f.ctx.tools.register(tool('beta'))
    beta(); f.ctx.tools.register(tool('beta'))
    await send(f)
    assert.equal((await registrationEvents(f)).length, 2)
    assert.match((await registrationEvents(f))[1].data.content[0].text, /restored \(registered again\).*beta/)
    assert.equal(f.host.state(f.agent).record.active.revision, applied.active.revision)
    assert.equal(f.host.state(f.agent).record.generation, applied.generation)
  } finally { await f.close() }
})

test('registration net toggles, scope, legacy missing state and retry final status', async () => {
  const f = await fixture()
  try {
    await send(f)
    f.release(); let release = f.ctx.tools.register(tool('alpha'))
    await send(f)
    assert.equal((await registrationEvents(f)).length, 0)
    const second = await f.ctx.agentLoop.create('registration-other', { provider: 'test', model: 'test' })
    second.ctx.tools.register(tool('private'))
    await send({ ...f, agent: second })
    release()
    const reject = f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    await send(f)
    assert.equal((await registrationEvents(f)).length, 0)
    reject()
    const drop = f.ctx.on('agent/pre-step', async (p, next) => { const d = await next(); return d.kind === 'enter' ? { ...d, messages: d.messages.filter(m => m.source?.form !== 'registration') } : d }, { prepend: true })
    await send(f)
    const pending = f.host.state(f.agent).record.registrationOutbox[0]
    assert(pending)
    assert.equal(f.host.state(f.agent).record.registrationState.entries[0].registered, true)
    await f.host.status(f.agent.session.id)
    assert.equal(f.host.state(f.agent).record.registrationOutbox[0].message.id, pending.message.id)
    release = f.ctx.tools.register(tool('alpha'))
    drop(); await send(f)
    assert.equal((await registrationEvents(f)).length, 0)
    assert.equal(f.host.state(f.agent).record.registrationOutbox.length, 0)
    f.host.state(f.agent).record = structuredClone(f.host.state(f.agent).record)
    delete f.host.state(f.agent).record.registrationState
    release(); await send(f)
    const event = (await registrationEvents(f))[0]
    assert.match(event.data.content[0].text, /unavailable.*alpha/)
    assert(!event.data.content[0].text.includes('private'))
    assert(!event.data.content[0].text.includes('startup'))
    f.ctx.tools.register(tool('alpha')); await send(f)
    assert.equal((await registrationEvents(f)).length, 2)
  } finally { await f.close() }
})

test('registration flush failure retains evidence but permits opposite transition', async () => {
  const f = await fixture()
  try {
    await send(f)
    f.ctx.tools.register(tool('beta'))
    const review = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    f.release(); await send(f)
    const applyId = f.host.state(f.agent).record.notice.message.id
    const first = f.host.state(f.agent).record.registrationOutbox[0].message.id
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    f.ctx.sessions.flush = async () => { throw new Error('registration flush failed') }
    f.ctx.tools.register(tool('alpha')); await send(f)
    assert.equal((await registrationEvents(f)).length, 2)
    assert.equal(f.host.state(f.agent).record.registrationOutbox[0].message.id, first)
    assert.match(f.host.state(f.agent).registrationError, /flush failed/)
    assert.equal((await f.ctx.sessionQuery.readSession(f.agent.session.id)).events.filter(e => e.type === 'user/message' && e.data.id === applyId).length, 1)
    f.ctx.sessions.flush = flush
  } finally { await f.close() }
})

test('pending Apply reminds already-known missing registrations exactly once', async () => {
  const f = await fixture()
  try {
    await send(f); f.release(); await send(f)
    // Preserve alpha in the reviewed candidate, then disable it after Apply.
    const alpha = f.ctx.tools.register(tool('alpha'))
    f.ctx.tools.register(tool('beta'))
    const review = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    alpha(); await send(f)
    assert.equal((await registrationEvents(f)).length, 2)
    assert.match((await registrationEvents(f))[1].data.content[0].text, /unavailable.*alpha/)
    await send(f)
    assert.equal((await registrationEvents(f)).length, 2)
  } finally { await f.close() }
})

test('registration verified persistence resume and invalidation', async () => {
  const dir = await directory(), persistence = await directory()
  const f = await fixture('native', dir, undefined, persistence)
  let id
  try {
    await send(f); f.release(); await send(f)
    id = f.host.state(f.agent).record.registrationOutbox[0].message.id
    await f.host.state(f.agent).checkpointJob
    await f.host.store.serial(f.agent.session.id, () => f.host.updateCheckpoint(f.host.state(f.agent)))
  } finally { await f.close() }
  const g = await fixture('native', dir, undefined, persistence, true)
  try {
    assert.equal(g.host.state(g.agent).record.registrationOutbox[0].message.id, id)
    await send(g)
    assert.equal((await registrationEvents(g)).length, 2)
    assert.match((await registrationEvents(g))[1].data.content[0].text, /restored.*alpha/)
    await send(g)
    assert.equal(g.host.state(g.agent).record.registrationOutbox.length, 0)
    assert.equal(g.host.state(g.agent).record.registrationState.entries[0].registered, true)
    assert.equal((await g.host.store.load(g.agent.session.id)).registrationState.entries[0].registered, true)
  } finally { await g.close() }
  const h = await fixture('native', dir)
  try {
    assert.equal(h.host.state(h.agent).record, null)
    const pending = send(h)
    while (h.host.state(h.agent).recovery?.phase !== 'awaiting-choice') await new Promise(resolve => setImmediate(resolve))
    await h.host.resolveRecovery(h.agent.session.id, h.host.state(h.agent).recovery.id, 'recapture')
    await pending
    assert.equal((await registrationEvents(h)).length, 0)
  } finally { await h.close() }
})

test('original rc.2 AgentLoop request freezes edits until idle apply; notification shares user request', async () => {
  const f = await fixture()
  try {
    await send(f)
    assert.equal(f.adapter.requests.length, 1)
    assert.equal(f.adapter.requests[0].tools[0].description, 'alpha')
    f.release(); f.ctx.tools.register(tool('alpha', 'new description', { type: 'object', properties: { path: { type: 'string' } } }))
    await send(f, 'second')
    assert.equal(f.adapter.requests[1].tools[0].description, 'alpha')
    let state = await f.host.status(f.agent.session.id)
    assert.deepEqual(state.diff.changed[0].fields, ['description', 'parameters'])
    const count = f.adapter.requests.length
    await f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    assert.equal(f.adapter.requests.length, count, 'apply must not wake agent')
    await send(f, 'third')
    assert.equal(f.adapter.requests.at(-1).tools[0].description, 'new description')
    assert(f.adapter.requests.at(-1).messages.some(m => m.source?.kind === 'prompt-freeze'))
  } finally { await f.close() }
})
for (const mode of MODES) test(`${mode}: real Tools, assembly, SDK and independent agent scopes`, async () => {
  const f = await fixture(mode)
  try {
    await send(f)
    const first = await assemble(f)
    const sdk = renderPrompt(first)
    f.ctx.tools.register(tool('beta', 'second capability'))
    const frozen = await assemble(f)
    assert.deepEqual(frozen.tools, first.tools)
    assert.equal(renderPrompt(frozen), sdk)
    const candidate = await f.host.status(f.agent.session.id)
    assert(candidate.diff.added.includes('beta'))
    await f.host.applySnapshot(candidate.sessionId, candidate.candidate.revision, candidate.generation, false)
    const updated = await assemble(f)
    if (mode !== 'ptc') assert(updated.tools.some(t => t.name === 'beta'))
    if (mode !== 'native') assert(renderPrompt(updated).includes('beta'))
    const second = await f.ctx.agentLoop.create('session-other', { provider: 'test', model: 'test' })
    second.ctx.tools.register(tool('private-tool'))
    await send({ ...f, agent: second })
    const other = await f.ctx.systemPrompt.assemble(assembleContextFor(second))
    assert(!f.host.state(f.agent).record.active.callables.some(t => t.name === 'private-tool'))
    assert(f.host.state(second).record.active.callables.some(t => t.name === 'private-tool'))
    assert(other)
  } finally { await f.close() }
})

test('real maintenance refuses competing apply and queues waking input behind successful apply', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0; f.ctx.tools.register(tool('beta'))
    const state = await f.host.status(f.agent.session.id)
    let release; const hold = new Promise(r => { release = r })
    const maintenance = f.agent.runMaintenance(() => hold)
    assert.equal(f.agent.status, 'idle')
    await assert.rejects(f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false), /active work/)
    release(); await maintenance
    const save = f.host.store.save.bind(f.host.store)
    let saving; const entered = new Promise(r => { saving = r })
    let complete; const barrier = new Promise(r => { complete = r })
    f.host.store.save = async record => { saving(); await barrier; return save(record) }
    const applying = f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    await entered
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'queued' }] }))
    assert.equal(f.adapter.requests.length, 0)
    complete(); await applying; await f.agent.whenIdle()
    assert(f.adapter.requests[0].tools.some(t => t.name === 'beta'))
    await assert.rejects(f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false), /Stale/)
  } finally { await f.close() }
})

test('write failure is not success; no change events emitted by projection or keep/apply', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0; f.ctx.tools.register(tool('beta'))
    const state = await f.host.status(f.agent.session.id), old = state.active.revision
    let changes = 0; f.ctx.on('tools/change', () => { changes++ })
    for (let i = 0; i < 10; i++) await assemble(f)
    assert.equal(changes, 0)
    f.host.store.save = async () => { throw new Error('ENOSPC injected') }
    await assert.rejects(f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false), /ENOSPC/)
    assert.equal(f.host.state(f.agent).record.active.revision, old)
    assert(f.host.state(f.agent).error.includes('persistence failed'))
  } finally { await f.close() }
})

test('snapshot filesystem roundtrip, checksum corruption, missing existing baseline', async () => {
  const dir = await directory(), f = await fixture('native', dir)
  let record
  try { await send(f); record = f.host.state(f.agent).record; assert.equal((await new Store(dir).load(record.sessionId)).active.revision, record.active.revision) }
  finally { await f.close() }
  const g = await fixture('native', dir)
  try {
    g.ctx.tools.register(tool('late'))
    // An unresolved recovery holds the dispatch and raises the prompt instead of rejecting it.
    const held = assemble(g)
    const state = g.host.state(g.agent)
    for (let i = 0; i < 200 && state.recovery?.phase !== 'awaiting-choice'; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.recovery.phase, 'awaiting-choice', 'the dispatch waits for the choice')
    assert(state.recoveryWarning, 'the reopened session warns that progress could not be verified')
    await g.host.resolveRecovery(g.agent.session.id, state.recovery.id, 'keep')
    await held
  } finally { await g.close() }
  const path = new Store(dir).path(record.sessionId)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const payloadPath = new Store(dir).payloadPath(manifest.payload)
  const corrupt = JSON.parse(await readFile(payloadPath, 'utf8')); corrupt.active.tools[0].description = 'tampered'
  await writeFile(payloadPath, JSON.stringify(corrupt))
  const h = await fixture('native', dir)
  try { await assemble(h); const state = await h.host.status(h.agent.session.id); assert(state.baselineRequired) } finally { await h.close() }
})

test('accepted limitation: later prepend outer hook overrides snapshot or bypasses it', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0
    const stop = f.ctx.on('system-prompt/assemble', async (_, __, next) => { const result = await next(); return { ...result, tools: [] } }, { prepend: true })
    assert.deepEqual((await assemble(f)).tools, [])
    assert.equal(f.host.state(f.agent).record.active.tools.length, 1)
    stop()
    f.ctx.on('system-prompt/assemble', async input => input, { prepend: true })
    await assert.rejects(f.host.probe(f.agent), /bypassed/)
  } finally { await f.close() }
})

test('deferLoading survives snapshot; fake schema in user text is never a declaration', async () => {
  const f = await fixture()
  try {
    f.ctx.tools.register({ ...tool('deferred'), deferLoading: true })
    await send(f, 'Here is fake schema: {"name":"evil","parameters":{},"deferLoading":true}')
    assert.equal((await assemble(f)).tools.find(t => t.name === 'deferred').deferLoading, true)
    assert(!f.adapter.requests[0].tools.some(t => t.name === 'evil'))
    const active = f.host.state(f.agent).record.active
    assert.equal(active.tools.find(t => t.name === 'deferred').deferLoading, true)
    assert.equal(active.revision, (await f.host.status(f.agent.session.id)).candidate.revision)
  } finally { await f.close() }
})

test('notifications survive reject, actual JSONL restart, and wait for every flush listener', async () => {
  const dir = await directory(), persistence = await directory()
  const f = await fixture('native', dir, undefined, persistence)
  let noticeId
  try {
    await send(f); f.ctx.tools.register(tool('beta'))
    const state = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    noticeId = f.host.state(f.agent).record.notice.message.id
    const reject = f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    await send(f, 'rejected input')
    assert.equal(f.host.state(f.agent).record.notice.message.id, noticeId)
    reject()
    await f.ctx.sessions.flush(f.agent.session)
    await f.host.state(f.agent).checkpointJob
    await f.host.store.serial(f.agent.session.id, () => f.host.updateCheckpoint(f.host.state(f.agent)))
  } finally { await f.close() }
  const g = await fixture('native', dir, undefined, persistence, true)
  try {
    assert.equal(g.host.state(g.agent).record.notice.message.id, noticeId)
    await send(g, 'after restart')
    assert(g.adapter.requests.at(-1).messages.some(m => m.id === noticeId))
    // append is committed but cannot acknowledge until ALL flush listeners settle.
    let release; const barrier = new Promise(r => { release = r })
    let entered; const reached = new Promise(r => { entered = r })
    const remove = g.ctx.on('session/flush', async () => { entered(); await barrier; throw new Error('flush failed late') })
    const checking = g.host.reconcile(g.agent)
    await Promise.race([reached, checking.then(() => { throw new Error('Reconcile returned without flushing: ' + JSON.stringify(g.host.state(g.agent).record.notice)) })])
    assert(g.host.state(g.agent).record.notice)
    release(); await assert.rejects(checking, /flush failed late/)
    assert(g.host.state(g.agent).record.notice)
    remove(); await g.host.reconcile(g.agent)
    assert.equal(g.host.state(g.agent).record.notice, null)
  } finally { await g.close() }
})

test('continuous applies merge net differences and no-user steps do not consume notices', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0
    const beta = f.ctx.tools.register(tool('beta'))
    let s = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(s.sessionId, s.candidate.revision, s.generation, false)
    beta(); f.ctx.tools.register(tool('gamma'))
    s = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(s.sessionId, s.candidate.revision, s.generation, false)
    const notice = f.host.state(f.agent).record.notice
    assert(!notice.from.callables.some(t => t.name === 'beta'))
    assert(notice.message.content[0].text.includes('gamma'))
    f.agent.inject(createUserMessage({ source: { kind: 'background-context' }, content: [{ type: 'text', text: 'not a human input' }] }))
    assert.equal(f.adapter.requests.length, 0)
    await send(f)
    const messages = f.adapter.requests[0].messages
    assert.equal(messages.filter(m => m.source?.kind === 'prompt-freeze').length, 1)
    assert(messages.some(m => m.source?.kind === 'user'))
  } finally { await f.close() }
})

test('running apply rejected, pre-step cancellation preserves pending notice, repeated input never duplicates committed id', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0; f.ctx.tools.register(tool('beta'))
    const s = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(s.sessionId, s.candidate.revision, s.generation, false)
    const id = f.host.state(f.agent).record.notice.message.id
    const cancel = f.ctx.on('agent/pre-step', async (payload, next) => { const result = await next(); payload.agent.cancel({ kind: 'user' }); return result })
    await send(f, 'cancelled')
    assert.equal(f.adapter.requests.length, 0)
    assert.equal(f.host.state(f.agent).record.notice.message.id, id)
    cancel()
    let release; f.adapter.wait = new Promise(r => { release = r })
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'running' }] }))
    await assert.rejects(f.host.applySnapshot(s.sessionId, s.candidate.revision, s.generation, false), /active work/)
    release(); await f.agent.whenIdle(); f.adapter.wait = null
    await send(f, 'next input')
    assert.equal(f.adapter.requests.at(-1).messages.filter(m => m.id === id).length, 1)
  } finally { await f.close() }
})

test('fork and existing session without sidecar capture on first dispatch; ordinary source text is not scanned', async () => {
  const f = await fixture()
  try {
    await send(f)
    const log = await f.ctx.sessionQuery.readSession(f.agent.session.id)
    const handle = await f.ctx.agentLoop.createAgent(f.ctx, { sessionId: 'fork-child', seed: log.events, inheritedEventCount: log.events.length, meta: { isSeeded: true, parentSession: f.agent.session.id }, agentOptions: { provider: 'test', model: 'test' } })
    const child = handle.agent
    await f.ctx.systemPrompt.assemble(assembleContextFor(child))
    const s = await f.host.status(child.session.id)
    assert.equal(s.baselineRequired, false)
    assert.equal(s.active, null)
    await send({ ...f, agent: child })
    assert(f.host.state(child).record.active)
    assert((await f.ctx.systemPrompt.assemble(assembleContextFor(child))).tools.length)
  } finally { await f.close() }
})

test('change notifications coalesce recursive restriction events without writing registry', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0
    let calls = 0, nested = false, dispose
    f.ctx.on('tools/change', () => {
      calls++
      if (!nested) { nested = true; dispose = f.agent.ctx.tools.restrict({ deny: ['alpha'] }) }
    })
    f.ctx.tools.register(tool('beta'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2)
    const state = await f.host.status(f.agent.session.id)
    assert(state.diff.removed.includes('alpha'))
    assert(state.diff.added.includes('beta'))
    assert((await assemble(f)).tools.some(t => t.name === 'alpha'))
    assert.equal(calls, 2)
    dispose()
  } finally { await f.close() }
})

test('native wire order and inner assembly transformations are snapshotted, generic text freezes', async () => {
  let reverse = false, prose = 'first'
  const f = await fixture('native', undefined, ctx => {
    ctx.systemPrompt.section({ name: 'unrelated', order: 200, text: () => prose })
    ctx.on('system-prompt/assemble', async (_, __, next) => { const a = await next(); return { ...a, tools: reverse ? [...a.tools].reverse() : a.tools } })
  })
  try {
    f.ctx.tools.register(tool('beta'))
    await send(f)
    const original = await assemble(f)
    reverse = true; prose = 'second'
    const frozen = await assemble(f)
    assert.deepEqual(frozen.tools, original.tools)
    assert(renderPrompt(frozen).includes('first'))
    const state = await f.host.status(f.agent.session.id)
    assert(state.diff.orderChanged)
    assert.equal(state.candidate.tools[0].name, 'beta')
  } finally { await f.close() }
})

test('actual rc.2 Typert registry and Gateway invoke status/apply with exact named codecs', async t => {
  const f = await fixture()
  try {
    const Registry = await dshPlugin('@deepseek-ai/dsh-typert-registry')
    const Gateway = await dshPlugin('@deepseek-ai/dsh-api-gateway')
    const { TYPERT } = await import('../lib/typert.host.mjs')
    await f.ctx.plugin(Registry)
    f.ctx.typert.register(TYPERT)
    // The 0.2.1 line's gateway injects `remoteAccess` (provided by dsh-api-remote-access), and cordis
    // defers a plugin whose injections are unmet, so the gateway would never mount. Compose a permissive
    // stub: the gateway consults it only for non-owner principals, and this in-process call is the owner.
    f.ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
    await f.ctx.plugin(Gateway, {})
    if (!f.ctx.typertGateway) {
      // Some host composition still does not mount the gateway; skip rather than report a false failure.
      t.skip('this host does not mount ctx.typertGateway with the stub remoteAccess service')
      return
    }
    await send(f); f.adapter.requests.length = 0; f.ctx.tools.register(tool('beta'))
    // The 0.2.1 line also asserts that the calling peer is live (rc.2 does not), and an owner principal
    // skips remote-access policy, so the stub above is never consulted for these calls.
    const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
    const invoke = (method, args) => f.ctx.typertGateway.invoke({ namespace: 'promptFreeze', method, args, peer })
    const state = await invoke('status', { id: f.agent.session.id })
    assert(state.diff.added.includes('beta'))
    const summary = await invoke('summary', { id: f.agent.session.id })
    assert.deepEqual(summary.candidate, { revision: state.candidate.revision })
    assert(!('diff' in summary))
    await invoke('applySnapshot', { id: state.sessionId, expectedRevision: state.candidate.revision, expectedGeneration: state.generation, baseline: false })
    assert.equal(f.host.state(f.agent).record.active.revision, state.candidate.revision)
  } finally { await f.close() }
})

test('temporary probe and flush errors recover without changing baseline', async () => {
  const f = await fixture('native', undefined, undefined, await directory())
  try {
    await send(f)
    const rev = f.host.state(f.agent).record.active.revision
    const fail = f.ctx.on('system-prompt/assemble', async () => { throw new Error('temporary probe failure') })
    let state = await f.host.status(f.agent.session.id)
    assert.match(state.error, /temporary/); assert.equal(state.baselineRequired, false)
    fail(); state = await f.host.status(f.agent.session.id)
    assert.equal(state.error, null); assert.equal(state.active.revision, rev)
    await send(f); f.adapter.requests.length = 0
    f.ctx.tools.register(tool('beta'))
    state = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    await send(f)
    const failFlush = f.ctx.on('session/flush', () => { throw new Error('temporary flush failure') })
    state = await f.host.status(f.agent.session.id)
    assert.match(state.error, /temporary flush/); assert.equal(state.baselineRequired, false)
    const active = state.active.revision
    failFlush(); state = await f.host.status(f.agent.session.id)
    assert.equal(state.error, null); assert.equal(state.active.revision, active)
    assert.equal(f.host.state(f.agent).record.notice, null)
  } finally { await f.close() }
})

test('notice retained in log but removed from current surface is requeued with new ID', async () => {
  const f = await fixture()
  try {
    await send(f); f.adapter.requests.length = 0; f.ctx.tools.register(tool('beta'))
    const s = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(s.sessionId, s.candidate.revision, s.generation, false)
    const notice = f.host.state(f.agent).record.notice
    const old = f.agent.session.append('user/message', notice.message, { surfaceOp: 'append' })
    f.agent.session.append('user/message', createUserMessage({ source: { kind: 'test-compaction' }, content: [{ type: 'text', text: 'summary without the notice' }] }), { sourceEventSeqs: [old.seq], surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq } })
    assert((await f.ctx.sessionQuery.readSession(f.agent.session.id)).events.some(e => e.type === 'user/message' && e.data.id === notice.message.id))
    assert(!(await f.ctx.sessionQuery.readSurface(f.agent.session.id)).events.some(e => e.type === 'user/message' && e.data.id === notice.message.id))
    await f.host.reconcile(f.agent)
    const fresh = f.host.state(f.agent).record.notice.message.id
    assert.notEqual(fresh, notice.message.id)
    await send(f)
    assert(f.adapter.requests[0].messages.some(m => m.id === fresh))
    assert(!f.adapter.requests[0].messages.some(m => m.id === notice.message.id))
  } finally { await f.close() }
})

test('PTC complete override is explicitly reported by idle probe', async () => {
  const f = await fixture('ptc')
  try {
    f.ctx.systemPrompt.section({ name: 'complete', order: 0, complete: true, text: 'Whole replacement' })
    const state = await f.host.status(f.agent.session.id)
    assert.match(state.error, /Unsupported complete/)
    await assemble(f)
    await send(f)
    assert.equal(f.host.state(f.agent).record, null)
    assert.match((await f.host.status(f.agent.session.id)).error, /correlate/)
  } finally { await f.close() }
})


test('empty lifecycle: creation, previews, rejected and cancelled steps never establish snapshot', async () => {
  let assemblies = 0
  const f = await fixture('native', undefined, ctx => ctx.on('system-prompt/assemble', async (_, __, next) => { assemblies++; return next() }))
  try {
    assert.equal(assemblies, 0)
    const id = f.agent.session.id
    await assemble(f); await f.host.status(id); await assemble(f)
    assert.equal(await f.host.store.load(id), null)
    assert.equal(f.host.state(f.agent).record, null)
    const reject = f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    await send(f); reject()
    const cancel = f.ctx.on('agent/pre-step', async (payload, next) => { const decision = await next(); payload.agent.cancel({ kind: 'user' }); return decision })
    await send(f); cancel()
    assert.equal(f.adapter.requests.length, 0)
    assert.equal(await f.host.store.load(id), null)
    f.release(); f.ctx.tools.register(tool('alpha', 'latest'))
    await send(f)
    assert.equal(f.host.state(f.agent).record.active.tools[0].description, 'latest')
    assert.equal(f.host.state(f.agent).record.notice, null)
  } finally { await f.close() }
})

test('first native dispatch captures actual outer-transformed wire tools, not probe candidate', async () => {
  const f = await fixture()
  try {
    await f.host.status(f.agent.session.id)
    f.ctx.on('system-prompt/assemble', async (_, __, next) => {
      const assembly = await next()
      return { ...assembly, tools: assembly.tools.map(t => ({ ...t, description: 'actual wire' })) }
    }, { prepend: true })
    await send(f)
    assert.equal(f.adapter.requests[0].tools[0].description, 'actual wire')
    assert.deepEqual(f.host.state(f.agent).record.active.tools, f.adapter.requests[0].tools)
    assert.deepEqual(f.host.state(f.agent).record.active.callables, f.adapter.requests[0].tools)
  } finally { await f.close() }
})

test('auxiliary stream does not capture; first write failure does not block request', async () => {
  const f = await fixture()
  try {
    for await (const chunk of f.ctx.llm.stream({ provider: 'test', model: 'test', sessionId: f.agent.session.id, purpose: 'session-title', messages: [], tools: [] })) {}
    for await (const chunk of f.ctx.llm.stream({ provider: 'test', model: 'test', sessionId: f.agent.session.id, messages: [], tools: [] })) {}
    assert.equal(f.host.state(f.agent).record, null)
    f.host.store.save = async () => { throw new Error('ENOSPC first capture') }
    await send(f)
    assert.equal(f.adapter.requests.length, 3)
    assert.equal(f.host.state(f.agent).record, null)
    assert.match((await f.host.status(f.agent.session.id)).error, /ENOSPC/)
    await assemble(f)
  } finally { await f.close() }
})

for (const mode of MODES) test(`${mode}: latest actual system text must match and probes cannot supply correlation`, async () => {
  const f = await fixture(mode)
  try {
    await f.host.status(f.agent.session.id)
    assert.equal(f.host.state(f.agent).observations.length, 0)
    const original = await assemble(f)
    const text = renderPrompt(original)
    const options = { sessionId: f.agent.session.id, tools: original.tools, messages: [{ role: 'system', content: text }, { role: 'system', content: 'unmatched latest prompt' }] }
    await f.host.capture(options)
    assert.equal(f.host.state(f.agent).record, null)
    const state = f.host.state(f.agent)
    state.observations.push({ text, snapshot: { ...state.observations[0].snapshot, sections: [...state.observations[0].snapshot.sections, { name: 'ambiguous', text: '', interpolate: false }], revision: 'ambiguous' } })
    await f.host.capture({ ...options, messages: [{ role: 'system', content: text }] })
    assert.equal(state.record, null)
    assert.match(state.captureError, /correlate/)
  } finally { await f.close() }
})


test('hot unmount progress quarantines active/outbox until explicit recapture', async () => {
  const dir = await directory(), f = await fixture('native', dir, undefined, await directory())
  try {
    await send(f); f.ctx.tools.register(tool('beta'))
    const review = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    await f.host.state(f.agent).checkpointJob
    const noticeId = f.host.state(f.agent).record.notice.message.id
    await f.hostFiber.dispose()
    f.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'gap' }] }), { surfaceOp: 'append' })
    await f.ctx.sessions.flush(f.agent.session)
    await f.ctx.plugin(PromptFreeze, { directory: dir, autoApplyBelow: '' })
    f.host = f.ctx.promptFreeze
    const recovered = await f.host.status(f.agent.session.id)
    assert(recovered.active); assert.equal(recovered.recovery.phase, 'pending'); assert(recovered.recoveryWarning)
    assert.equal(f.host.state(f.agent).record, null)
    const pending = send(f)
    while (f.host.state(f.agent).recovery?.phase !== 'awaiting-choice') await new Promise(resolve => setImmediate(resolve))
    await f.host.resolveRecovery(f.agent.session.id, f.host.state(f.agent).recovery.id, 'recapture')
    await pending
    assert(f.host.state(f.agent).record.active)
    assert.equal((await f.host.summary(f.agent.session.id)).recoveryOutcome.kind, 'recaptured')
    assert(!f.adapter.requests.at(-1).messages.some(m => m.id === noticeId))
  } finally { await f.close() }
})

for (const mode of MODES) test(`${mode}: generic section disable/enable, text-only edits and exact system stability until apply`, async () => {
  let text = 'Pipeline first', empty = '', releasePipeline
  const f = await fixture(mode, undefined, ctx => {
    ctx.systemPrompt.section({ name: 'external:before', order: -20, text: 'Before' })
    releasePipeline = ctx.systemPrompt.section({ name: 'tool:pipeline', order: -10, text: () => text })
    ctx.systemPrompt.section({ name: 'external:empty', order: -5, text: () => empty })
    ctx.systemPrompt.section({ name: 'external:after', order: 20, text: 'After' })
  })
  try {
    await send(f)
    const system = () => f.adapter.requests.at(-1).messages.filter(m => m.role === 'system')
    const original = JSON.stringify(system())
    text = 'Pipeline text-only edit'; empty = 'Now populated'
    let state = await f.host.status(f.agent.session.id)
    assert(state.diff.sections.changed.some(s => s.name === 'tool:pipeline' && s.before === 'Pipeline first' && s.after === text))
    assert.equal(state.diff.wireChanged, false)
    await send(f); assert.equal(JSON.stringify(system()), original)
    releasePipeline()
    f.ctx.systemPrompt.section({ name: 'arbitrary:brand-new-plugin', order: -15, text: 'New guidance' })
    await send(f); assert.equal(JSON.stringify(system()), original)
    state = await f.host.status(f.agent.session.id)
    assert(state.diff.sections.removed.some(s => s.name === 'tool:pipeline'))
    assert(state.diff.sections.added.some(s => s.name === 'arbitrary:brand-new-plugin'))
    await f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    await send(f)
    assert.notEqual(JSON.stringify(system()), original)
    const notice = f.adapter.requests.at(-1).messages.find(m => m.source?.kind === 'prompt-freeze')
    assert(!notice.content[0].text.includes('Pipeline first'))
    assert(notice.content[0].text.includes('arbitrary:brand-new-plugin'))
    assert.deepEqual((await assemble(f)).sections.map(s => s.name), state.candidate.sectionLayout)
  } finally { await f.close() }
})

test('managed variables freeze once; all reserved live sections and runtime contexts remain live', async () => {
  let value = 'first'
  const f = await fixture('native', undefined, ctx => {
    ctx.systemPrompt.variable('test_value', () => value)
    ctx.systemPrompt.section({ name: 'external:variable', order: 0, text: 'Managed {{test_value}}' })
    ctx.systemPrompt.context({ name: 'test:context', order: 0, text: 'Context {{test_value}}' })
  })
  try {
    await send(f)
    for (const name of LIVE_SECTION_NAMES) f.agent.ctx.systemPrompt.section({ name, order: 10, text: `${name} {{test_value}}` })
    const initial = await f.host.status(f.agent.session.id)
    value = 'second {{literal}}'
    const a = await assemble(f), rendered = renderPrompt(a)
    assert(rendered.includes('Managed first'))
    for (const name of LIVE_SECTION_NAMES) assert(rendered.includes(`${name} second {{literal}}`))
    assert(renderContextSections(a).some(s => s.text.includes('Context second {{literal}}')))
    assert.equal(a.sections.find(s => s.name === 'external:variable').interpolate, false)
    const state = await f.host.status(f.agent.session.id)
    assert.deepEqual(state.diff.sections.changed.map(s => s.name), ['external:variable'])
    assert.equal(state.active.revision, initial.active.revision)
  } finally { await f.close() }
})

test('legacy format2 persists old tool baseline and outbox until explicit coverage upgrade', async () => {
  const dir = await directory(), persistence = await directory()
  const f = await fixture('native', dir, ctx => ctx.systemPrompt.section({ name: 'external:legacy', order: 0, text: 'old prose' }), persistence)
  let legacyRevision, noticeId
  try {
    await send(f); f.ctx.tools.register(tool('beta'))
    const state = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(state.sessionId, state.candidate.revision, state.generation, false)
    await f.host.state(f.agent).checkpointJob
    const record = structuredClone(f.host.state(f.agent).record)
    const legacy = snap => { const { coverage, sectionLayout, revision: oldRevision, ...body } = snap; body.sections = body.sections.filter(s => ['tools:sdk', 'tools:ptc-only'].includes(s.name)); return { ...body, revision: revision(body) } }
    record.active = legacy(record.active); record.notice.from = legacy(record.notice.from); delete record.observation
    legacyRevision = record.active.revision; noticeId = record.notice.message.id
    await f.host.store.save(record)
  } finally { await f.close() }
  const g = await fixture('native', dir, ctx => ctx.systemPrompt.section({ name: 'external:legacy', order: 0, text: 'new prose' }), persistence, true)
  try {
    const state = await g.host.status(g.agent.session.id)
    assert(state.upgradeRequired); assert.equal(state.observation.baselineAvailable, false); assert.equal(state.active.revision, legacyRevision)
    assert.equal(g.host.state(g.agent).record.notice.message.id, noticeId)
    assert(renderPrompt(await assemble(g)).includes('new prose'))
    assert((await assemble(g)).tools.some(t => t.name === 'beta'))
    await g.host.keep(state.sessionId, state.candidate.revision, state.generation)
    const review = await g.host.status(state.sessionId)
    assert(review.upgradeRequired)
    await g.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    assert.equal((await g.host.status(review.sessionId)).upgradeRequired, false)
    assert.equal(g.host.state(g.agent).record.notice.from.coverage, undefined)
    assert(g.host.state(g.agent).record.notice.message.content[0].text.includes('external:legacy'))
  } finally { await g.close() }
})

test('native complete override and duplicate names fail safely', async () => {
  const f = await fixture()
  try {
    await send(f)
    const remove = f.ctx.systemPrompt.section({ name: 'complete', order: 0, complete: true, text: 'Replacement' })
    assert.match((await f.host.status(f.agent.session.id)).error, /Unsupported complete/)
    remove()
    f.ctx.on('system-prompt/assemble', async (_, __, next) => { const a = await next(); return { ...a, sections: [{ name: 'duplicate', text: 'a' }, { name: 'duplicate', text: 'b' }] } })
    assert.match((await f.host.status(f.agent.session.id)).error, /Duplicate/)
  } finally { await f.close() }
})


test('all-unit observer tracks live changes without freezing or stale apply; keep never resets observation', async () => {
  let value = 'first'
  const f = await fixture('native', undefined, ctx => {
    ctx.systemPrompt.variable('observer_value', () => value)
    ctx.systemPrompt.variable('undefined_value', () => undefined)
    ctx.systemPrompt.section({ name: 'plan:policy', order: 1, text: 'Policy {{observer_value}}' })
    ctx.systemPrompt.context({ name: 'observer:context', order: 0, text: 'Context {{observer_value}}' })
  })
  try {
    await send(f)
    const first = await f.host.status(f.agent.session.id)
    assert(first.observation.baselineAvailable)
    assert.deepEqual(first.observation.baseline.variables.find(v => v.name === 'undefined_value'), { name: 'undefined_value', defined: false })
    const dropVariable = f.ctx.systemPrompt.variable('added_variable', () => 'temporary')
    const dropContext = f.ctx.systemPrompt.context({ name: 'added:context', order: 20, text: 'temporary context' })
    value = 'second'
    const live = await f.host.status(f.agent.session.id)
    assert.equal(live.candidate.revision, first.candidate.revision)
    assert(live.observation.diff.variables.added.some(v => v.name === 'added_variable'))
    assert(live.observation.diff.contexts.added.some(v => v.name === 'added:context'))
    assert(live.observation.diff.sections.changed.some(s => s.name === 'plan:policy' && s.after.live))
    assert(live.observation.diff.contexts.changed.some(s => s.name === 'observer:context' && s.after.text === 'Context second'))
    assert(live.observation.diff.variables.changed.some(s => s.name === 'observer_value' && s.after.value === 'second'))
    await f.host.applySnapshot(live.sessionId, live.candidate.revision, live.generation, false)
    assert.equal(f.host.state(f.agent).record.notice, null)
    assert.equal(f.host.state(f.agent).record.observation.revision, first.observation.baseline.revision)
    await f.host.keep(live.sessionId, live.candidate.revision, live.generation)
    assert.equal(f.host.state(f.agent).record.observation.revision, first.observation.baseline.revision)
    f.ctx.tools.register(tool('observer-new-tool'))
    const review = await f.host.status(f.agent.session.id)
    assert(review.observation.diff.tools.added.some(t => t.name === 'observer-new-tool'))
    value = 'third'
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    const saved = await f.host.store.load(review.sessionId)
    assert(saved.observation.variables.some(v => v.name === 'observer_value' && v.value === 'third'))
    assert(!saved.notice.message.content[0].text.includes('Context third'))
    assert(!saved.notice.message.content[0].text.includes('added_variable'))
    dropVariable(); dropContext()
    const removed = await f.host.status(review.sessionId)
    assert(removed.observation.diff.variables.removed.some(v => v.name === 'added_variable'))
    assert(removed.observation.diff.contexts.removed.some(v => v.name === 'added:context'))
    assert(renderContextSections(await assemble(f)).some(s => s.text === 'Context third'))
  } finally { await f.close() }
})

test('ambiguous same-system assemblies preserve snapshot capture but not invented observation baseline', async () => {
  let value = 'first'
  const f = await fixture('native', undefined, ctx => ctx.systemPrompt.variable('observation_only', () => value))
  try {
    await assemble(f); value = 'second'; await send(f)
    assert(f.host.state(f.agent).record.active)
    assert.equal((await f.host.status(f.agent.session.id)).observation.baselineAvailable, false)
  } finally { await f.close() }
})


test('verified JSONL resume retains separate observation baseline', async () => {
  const dir = await directory(), persistence = await directory()
  const f = await fixture('native', dir, ctx => ctx.systemPrompt.variable('resume_observer', () => 'old'), persistence)
  let baseline
  try {
    await send(f); await f.host.state(f.agent).checkpointJob
    await f.host.store.serial(f.agent.session.id, () => f.host.updateCheckpoint(f.host.state(f.agent)))
    baseline = f.host.state(f.agent).record.observation.revision
  } finally { await f.close() }
  const g = await fixture('native', dir, ctx => ctx.systemPrompt.variable('resume_observer', () => 'new'), persistence, true)
  try {
    const state = await g.host.status(g.agent.session.id)
    assert.equal(state.observation.baseline.revision, baseline)
    assert(state.observation.diff.variables.changed.some(v => v.name === 'resume_observer' && v.before.value === 'old' && v.after.value === 'new'))
    assert.equal(state.active.revision, state.candidate.revision)
  } finally { await g.close() }
})
