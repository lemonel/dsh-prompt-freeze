import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
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
import { parseThreshold } from '../lib/auto-apply.mjs'
import { Config } from '../lib/index.mjs'
import { PromptFreeze } from '../lib/host.mjs'
import { prepareRegistration } from '../lib/registration.mjs'
import { Store, diff, revision, LIVE_SECTION_NAMES } from '../lib/core.mjs'
import { dshInternal } from './dsh-internal.mjs'

test('unavailable estimates retain last display value but never auto-apply', () => {
  const host = Object.create(PromptFreeze.prototype)
  host.settingsMetadata = () => ({ thresholdTokens: 24000 })
  const state = { lastInputTokens: 12000 }
  assert.deepEqual(host.autoMetadata(state), { thresholdTokens: 24000, inputTokens: 12000, inputStale: true, eligible: false })
  assert.equal(host.estimateAuto(state).eligible, false)
  assert.equal(state.autoApply.inputTokens, 12000)
  assert.equal(state.autoApply.inputStale, true)
  assert.equal(host.autoMetadata({}).inputTokens, null)
  assert.equal(host.autoMetadata({ lastInputTokens: 0 }).inputTokens, 0)
})

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
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
    for (const usage of this.usages ?? []) yield { type: 'usage', usage: { outputTokens: 1, ...usage } }
    yield { type: 'finish', reason: 'stop' }
  }
}
async function fixture(mode = 'native', stateDir, beforeHost, persistenceRoot, resume = false, autoApplyBelow = '', delegated = false) {
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
  const hostFiber = await ctx.plugin(PromptFreeze, Config({ directory: stateDir ?? await directory(), autoApplyBelow }))
  const host = ctx.promptFreeze
  const agent = resume ? (await ctx.agentLoop.resume(ctx, { resumeSessionId: 'session-test', agentOptions: { provider: 'test', model: 'test' } })).agent : await ctx.agentLoop.create('session-test', { provider: 'test', model: 'test' }, delegated ? { delegationDepth: 1 } : {})
  return { ctx, agent, adapter, host, hostFiber, release, async close() { await ctx.fiber.dispose() } }
}
const send = async (f, text = 'hello') => { f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await f.agent.whenIdle() }
const assemble = f => f.ctx.systemPrompt.assemble(assembleContextFor(f.agent))

test('optional recovery estimate uses real registry and disappears on unregister', async () => {
  const f = await fixture()
  try {
    const state = f.host.state(f.agent)
    state.recovery = { id: 'estimate-registry', phase: 'awaiting-choice' }
    assert.equal(Object.hasOwn((await f.host.summary(f.agent.session.id)).recovery, 'estimatedContextInputTokens'), false)
    const release = f.ctx.sessionProjections.register({ key: 'contextPressure', stateVersion: 1,
      stateSchema: { parse: value => value }, init: () => ({ projectedTokens: 123 }), apply: state => state,
      wire: { viewSchema: { parse: value => value }, view: state => state } })
    assert.equal((await f.host.summary(f.agent.session.id)).recovery.estimatedContextInputTokens, 123)
    assert.equal((await f.host.status(f.agent.session.id)).recovery.estimatedContextInputTokens, 123)
    release()
    assert.equal(Object.hasOwn((await f.host.summary(f.agent.session.id)).recovery, 'estimatedContextInputTokens'), false)
    state.recovery = null
  } finally { await f.close() }
})

test('session settings update does not probe or write snapshots; next idle send uses override', async () => {
  const f = await fixture()
  try {
    const id = f.agent.session.id, state = f.host.state(f.agent)
    const probe = f.host.probe, save = f.host.store.save
    f.host.probe = () => assert.fail('settings must not probe')
    f.host.store.save = () => assert.fail('settings must not write snapshots')
    const first = await f.host.setAutoApply(id, '1M', 0)
    assert.equal(first.active, null)
    assert.equal(first.autoApply.thresholdTokens, 1000000)
    assert.equal(first.autoApply.defaultThresholdTokens, null)
    assert.equal(first.autoApply.settingsRevision, 1)
    f.host.probe = probe; f.host.store.save = save
    await send(f)
    f.release(); f.ctx.tools.register(tool('alpha', 'override applied'))
    await send(f)
    assert.equal(state.record.active.tools[0].description, 'override applied')
    const generation = state.record.generation
    assert.equal((await f.host.setAutoApply(id, '', 1)).autoApply.thresholdTokens, null)
    assert.equal(state.record.generation, generation)
    await assert.rejects(f.host.setAutoApply(id, null, 1), /Stale settings/)
    assert.equal((await f.host.setAutoApply(id, null, 2)).autoApply.settingsRevision, 3)
  } finally { await f.close() }
})

test('settings reload inherits new plugin default; corrupt settings fail closed independently', async () => {
  const dir = await directory()
  const f = await fixture('native', dir)
  await f.host.setAutoApply(f.agent.session.id, null, 0)
  await f.close()
  const g = await fixture('native', dir, undefined, undefined, false, '24K')
  try {
    const state = g.host.state(g.agent)
    assert.equal(g.host.metadata(state).autoApply.thresholdTokens, 24000)
    assert.equal(g.host.metadata(state).autoApply.settingsRevision, 1)
    await writeFile(g.host.settings.path(g.agent.session.id), '{bad')
    assert.equal((await g.host.status(g.agent.session.id)).autoApply.thresholdTokens, 24000)
    await assert.rejects(g.host.setAutoApply(g.agent.session.id, '', 1))
    const result = await g.host.status(g.agent.session.id)
    assert.equal(result.autoApply.thresholdTokens, null)
    assert.equal(result.autoApply.eligible, false)
    assert.match(result.autoApply.settingsError, /settings failed/)
    assert.equal(result.errors.storage, null)
    assert.equal(await readFile(g.host.settings.path(g.agent.session.id), 'utf8'), '{bad')
  } finally { await g.close() }
})

test('threshold config decimal K/M parsing and invalid input', () => {
  for (const [text, tokens] of [['', null], ['  ', null], ['1000',1000], ['1K',1000], ['1.5m',1500000]]) assert.equal(parseThreshold(text), tokens)
  for (const text of ['0','-1','NaN','1.2','1e3','2GiB',2]) assert.throws(() => parseThreshold(text))
})
for (const threshold of [null, 1, 1000000]) test(`real loop idle send threshold ${threshold}`, async () => {
  const f = await fixture()
  try {
    await send(f)
    f.host.thresholdTokens = threshold
    f.release(); f.ctx.tools.register(tool('alpha', 'new description'))
    await send(f)
    await f.agent.whenIdle()
    assert.equal(f.adapter.requests.at(-1).tools[0].description, threshold === 1000000 ? 'new description' : 'alpha')
    const view = await f.host.status(f.agent.session.id)
    assert.equal(view.autoApply.thresholdTokens, threshold)
    assert.equal(typeof view.autoApply.inputTokens, 'number')
  } finally { await f.close() }
})

for (const delta of [-1, 0, 1]) test(`strict estimated threshold boundary ${delta}`, async () => {
  const f = await fixture()
  try {
    await send(f); f.host.thresholdTokens = 1000000
    f.release(); f.ctx.tools.register(tool('alpha', 'changed'))
    const estimate = f.host.estimateAuto.bind(f.host)
    f.host.estimateAuto = (...args) => { const result = estimate(...args); f.host.thresholdTokens = result.inputTokens + delta; return estimate(...args) }
    await send(f); await f.agent.whenIdle()
    assert.equal(f.adapter.requests.at(-1).tools[0].description, delta > 0 ? 'changed' : 'alpha')
  } finally { await f.close() }
})
test('running injections do not apply; idle no changes does not commit', async () => {
  const f = await fixture()
  try {
    await send(f); f.host.thresholdTokens = 1000000
    const before = f.host.state(f.agent).record.generation
    await send(f); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.generation, before)
    let release; f.adapter.wait = new Promise(resolve => { release = resolve })
    f.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'start'}]}))
    while (f.adapter.requests.length < 3) await new Promise(resolve => setImmediate(resolve))
    f.release(); f.ctx.tools.register(tool('alpha', 'changed'))
    f.agent.inject(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'injected'}]}))
    release(); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.active.tools[0].description, 'alpha')
  } finally { await f.close() }
})
test('cancel while probe pending does not apply', async () => {
  const f = await fixture()
  try {
    await send(f); f.host.thresholdTokens = 1000000
    f.release(); f.ctx.tools.register(tool('alpha','changed'))
    const probe = f.host.probe.bind(f.host)
    f.host.probe = async agent => { const value = await probe(agent); if (f.host.state(agent).busy) agent.cancel({kind:'user'}); return value }
    await send(f); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.active.tools[0].description, 'alpha')
  } finally { await f.close() }
})
test('unknown media fails closed and later rejection retains idle-send apply', async () => {
  const f = await fixture()
  try {
    await send(f); f.host.thresholdTokens = 1000000
    f.release(); f.ctx.tools.register(tool('alpha','changed'))
    f.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'image',url:'unknown'}]}))
    await f.agent.whenIdle(); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.active.tools[0].description, 'alpha')
    assert.equal((await f.host.summary(f.agent.session.id)).autoApply.inputTokens, null)
  } finally { await f.close() }
  const g = await fixture()
  try {
    await send(g); g.host.thresholdTokens = 1000000
    g.release(); g.ctx.tools.register(tool('alpha','changed'))
    g.ctx.on('agent/pre-step', async () => ({kind:'reject'}))
    await send(g); await g.agent.whenIdle()
    assert.equal(g.host.state(g.agent).record.active.tools[0].description,'changed')
    assert(g.host.state(g.agent).record.notice)
  } finally { await g.close() }
})

test('auto reprobes candidate drift and coalesces pending notice', async () => {
  const f = await fixture()
  try {
    await send(f)
    f.release(); const release = f.ctx.tools.register(tool('alpha','intermediate'))
    const review = await f.host.status(f.agent.session.id)
    await f.host.applySnapshot(review.sessionId, review.candidate.revision, review.generation, false)
    const from = f.host.state(f.agent).record.notice.from.revision
    release(); f.ctx.tools.register(tool('alpha','latest changed candidate'))
    f.host.thresholdTokens = 1000000
    await send(f); await f.agent.whenIdle()
    assert.equal(f.adapter.requests.at(-1).tools[0].description, 'latest changed candidate')
    assert.equal(f.host.state(f.agent).record.notice.from.revision, from)
    assert.equal(f.adapter.requests.at(-1).messages.filter(m => m.source?.form === 'notice').length, 1)
    assert.match(f.adapter.requests.at(-1).messages.find(m => m.source?.form === 'notice').content[0].text, /automatic policy/)
  } finally { await f.close() }
})

test('schema-configured auto applies changed system in same next request', async () => {
  let text = 'old managed section'
  const f = await fixture('native', undefined, ctx => ctx.systemPrompt.section({ name:'test:managed',order:0,text:()=>text }), undefined, false, '1M')
  try {
    await send(f); text = 'new managed section'
    await send(f); await f.agent.whenIdle()
    const system = f.adapter.requests.at(-1).messages.filter(m=>m.role==='system').map(m=>m.content.map(b=>b.text).join('')).join('')
    assert.match(system,/new managed section/)
    assert.doesNotMatch(system,/old managed section/)
    assert.equal(f.host.thresholdTokens,1000000)
  } finally { await f.close() }
})
test('foreign maintenance reservation does not throw from inbox listener', async () => {
  const f = await fixture('native', undefined, undefined, undefined, false, '1M')
  try {
    await send(f)
    let release
    const job = f.agent.runMaintenance(() => new Promise(resolve => { release=resolve }))
    assert.doesNotThrow(()=>f.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'queued'}]})))
    release(); await job; await f.agent.whenIdle()
    assert.equal(f.adapter.requests.length,2)
  } finally { await f.close() }
})
test('failed auto write preserves active baseline and requires explicit recovery', async () => {
  const f = await fixture('native', undefined, undefined, undefined, false, '1M')
  try {
    await send(f); await f.host.state(f.agent).checkpointJob
    const old = f.host.state(f.agent).record.active.revision
    f.release(); f.ctx.tools.register(tool('alpha','changed'))
    const save=f.host.store.save
    f.host.store.save=async()=>{throw new Error('simulated disk failure')}
    await send(f); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.active.revision,old)
    assert.match(f.host.state(f.agent).error,/persistence failed/)
    f.host.store.save=save
    await send(f); await f.agent.whenIdle()
    assert.equal(f.host.state(f.agent).record.active.revision,old)
  } finally { await f.close() }
})

async function recoveryFixture(changed = false, delegated = false) {
  const dir = await directory(), f = await fixture('native', dir, undefined, undefined, false, '', delegated)
  await send(f)
  const old = f.host.state(f.agent).record
  await f.close()
  const g = await fixture('native', dir, undefined, undefined, false, '1M', delegated)
  if (changed) { g.release(); g.ctx.tools.register(tool('alpha', 'new recovery content')) }
  return { g, old, dir }
}
async function snapshotBytes(store) {
  const entries = await readdir(store.directory, { recursive: true, withFileTypes: true })
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name)
    return [path, await readFile(path)]
  })))
}
async function awaiting(f) {
  for (let i = 0; i < 200; i++) {
    if (f.host.state(f.agent).recovery?.phase === 'awaiting-choice') return f.host.state(f.agent).recovery.id
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('recovery did not request a choice')
}
for (const choice of ['keep', 'recapture']) {
  test(`pending recovery ${choice} is memory-only until the next real send`, async () => {
    const { g, old } = await recoveryFixture(true)
    try {
      const state = g.host.state(g.agent), id = state.recovery.id
      const bytes = await snapshotBytes(g.host.store)
      assert.equal((await g.host.status(g.agent.session.id)).recovery.phase, 'pending')
      await assert.rejects(g.host.resolveRecovery(g.agent.session.id, 'stale', choice), /Stale/)
      const answer = await g.host.resolveRecovery(g.agent.session.id, id, choice)
      assert.equal(answer.recovery.phase, choice)
      assert.equal(answer.recoveryOutcome, null)
      await assert.rejects(g.host.resolveRecovery(g.agent.session.id, id, choice === 'keep' ? 'recapture' : 'keep'), /Stale/)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(g.agent.status, 'idle')
      assert.equal(g.adapter.requests.length, 0)
      assert.equal(state.record, null)
      assert.deepEqual(await snapshotBytes(g.host.store), bytes)
      await send(g)
      assert.equal(g.adapter.requests.length, 1)
      assert.equal(g.adapter.requests[0].tools[0].description, choice === 'keep' ? 'alpha' : 'new recovery content')
      assert.equal(state.recovery, null)
      assert.equal(state.quarantine, null)
      assert.equal(state.record.generation, old.generation + 1)
      assert.equal(state.recoveryOutcome.kind, choice === 'keep' ? 'kept-changed' : 'recaptured')
    } finally { await g.close() }
  })
  test(`pending recovery ${choice} selection is lost on host reload before sending`, async () => {
    const { g, dir } = await recoveryFixture(true)
    const id = g.host.state(g.agent).recovery.id, bytes = await snapshotBytes(g.host.store)
    try {
      await g.host.resolveRecovery(g.agent.session.id, id, choice)
      assert.equal(g.adapter.requests.length, 0)
    } finally { await g.close() }
    const h = await fixture('native', dir)
    try {
      const state = h.host.state(h.agent)
      assert.equal(state.recovery.phase, 'pending')
      assert.notEqual(state.recovery.id, id)
      assert.equal(state.record, null)
      assert.equal(state.recoveryOutcome, undefined)
      assert.equal(h.adapter.requests.length, 0)
      assert.deepEqual(await snapshotBytes(h.host.store), bytes)
      await assert.rejects(h.host.resolveRecovery(h.agent.session.id, id, choice), /Stale/)
    } finally { await h.close() }
  })
  test(`pending recovery ${choice} failed write remains pending and preserves saved bytes`, async () => {
    const { g } = await recoveryFixture(true)
    try {
      const state = g.host.state(g.agent), id = state.recovery.id
      const bytes = await snapshotBytes(g.host.store), quarantine = state.quarantine
      await g.host.resolveRecovery(g.agent.session.id, id, choice)
      g.host.store.save = async () => { throw new Error('preselected recovery write failed') }
      await send(g)
      assert.equal(state.recovery.phase, 'pending')
      assert.notEqual(state.recovery.id, id)
      assert.match(state.recovery.error, /preselected recovery write failed/)
      assert.equal(state.recoveryOutcome, undefined)
      assert.equal(state.quarantine, quarantine)
      assert.equal(state.record, null)
      assert.deepEqual(await snapshotBytes(g.host.store), bytes)
      await assert.rejects(g.host.resolveRecovery(g.agent.session.id, id, choice), /Stale/)
    } finally { await g.close() }
  })
}
for (const [choice, changed, outcome] of [['keep',false,'kept-unchanged'],['keep',true,'kept-changed'],['recapture',true,'recaptured']]) test(`recovery ${outcome}: real send reservation, no probe, generation and stale answer`, async () => {
  const { g, old } = await recoveryFixture(changed)
  try {
    const state = g.host.state(g.agent)
    assert.equal(state.recovery.phase, 'pending')
    const displayedId = state.recovery.id
    assert.equal(state.record, null)
    assert.equal((await g.host.summary(g.agent.session.id)).autoApply.eligible, false)
    // assemble() is the request path itself, so with an unresolved recovery it now holds the turn and
    // raises the prompt instead of rejecting; the send below is that same hold, asserted through
    // awaiting() and resolveRecovery().
    await assert.rejects(g.host.applySnapshot(g.agent.session.id, old.active.revision, old.generation, false), /Resolve snapshot recovery/)
    const probe = g.host.probe
    g.host.probe = () => assert.fail('recovery send must not preview')
    const pending = send(g)
    const id = await awaiting(g)
    assert.equal(id, displayedId, 'normal send preserves the pending request shown in an open dialog')
    assert.equal(g.adapter.requests.length, 0)
    await g.host.store.serial(g.agent.session.id, () => {}) // no lock held across UI wait
    await assert.rejects(g.host.resolveRecovery(g.agent.session.id, 'stale', choice), /Stale/)
    const answer = await g.host.resolveRecovery(g.agent.session.id, id, choice)
    assert.equal(answer.recovery.phase, choice)
    assert.equal(answer.recoveryOutcome, null)
    await assert.rejects(g.host.resolveRecovery(g.agent.session.id, id, choice), /Stale/)
    await pending
    g.host.probe = probe
    assert.equal(state.recovery, null)
    assert.equal(state.recoveryOutcome.kind, outcome)
    assert.equal(state.record.generation, old.generation + 1)
    assert.equal(g.adapter.requests.at(-1).tools[0].description, choice === 'keep' ? 'alpha' : 'new recovery content')
  } finally { await g.close() }
})
test('recovery cancellation with retained inbox blocks dispatch, new sends get new IDs; disposal clears inbox', async () => {
  const { g } = await recoveryFixture(true)
  try {
    const pending = send(g), id = await awaiting(g)
    g.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'second'}]}))
    assert.equal(g.host.state(g.agent).recovery.id, id)
    g.agent.cancel({kind:'user'}, {keepInbox:true})
    await pending
    assert.equal(g.adapter.requests.length, 0)
    // Cancelling the turn keeps the prompt answerable instead of dropping it back to pending.
    assert.equal(g.host.state(g.agent).recovery.phase, 'awaiting-choice')
    assert.equal(g.host.state(g.agent).recovery.id, id)
    const again = send(g)
    let next = id
    for (let i = 0; i < 200 && next === id; i++) { await new Promise(resolve => setImmediate(resolve)); next = g.host.state(g.agent).recovery?.id ?? next }
    assert.notEqual(next,id)
    await g.hostFiber.dispose()
    await again
    assert.equal(g.agent.inbox.hasPending, false)
    assert.equal(g.adapter.requests.length, 0)
  } finally { await g.close() }
})
test('recovery commit failure reports no success and keeps quarantined baseline', async () => {
  const { g } = await recoveryFixture(true)
  try {
    const pending = send(g), id = await awaiting(g)
    g.host.store.save = async () => { throw new Error('recovery write failed') }
    await g.host.resolveRecovery(g.agent.session.id,id,'keep')
    await pending
    const state = g.host.state(g.agent)
    assert.equal(state.recoveryOutcome, undefined)
    assert.equal(state.recovery.phase,'pending')
    assert.match(state.recovery.error,/recovery write failed/)
    assert(state.quarantine)
    assert.equal(g.adapter.requests.length,0)
  } finally { await g.close() }
})

test('recovery recapture write failure and incompatible keep never report success', async () => {
  for (const choice of ['keep','recapture']) {
    const { g } = await recoveryFixture(true)
    try {
      const pending = send(g), id = await awaiting(g)
      if (choice === 'keep') {
        const state = g.host.state(g.agent)
        state.quarantine = { ...state.quarantine, active: { ...state.quarantine.active, mode: 'both' } }
      } else g.host.store.save = async () => { throw new Error('recapture write failed') }
      await g.host.resolveRecovery(g.agent.session.id,id,choice)
      await pending
      const state = g.host.state(g.agent)
      assert.equal(state.recoveryOutcome, undefined)
      assert.equal(state.recovery.phase, 'pending')
      assert.match(state.recovery.error, choice === 'keep' ? /mode incompatible/ : /recapture write failed/)
    } finally { await g.close() }
  }
})
test('a delegated session keeps the quarantined snapshot automatically instead of prompting', async () => {
  const { g } = await recoveryFixture(true, true)
  try {
    assert.equal(g.host.delegated(g.agent), true, 'the session header carries the delegation depth')
    assert.equal(g.host.state(g.agent).recovery.phase, 'pending')
    await send(g)
    await g.agent.whenIdle()
    const state = g.host.state(g.agent)
    assert.equal(state.recovery, null, 'a delegated session never waits for a choice nobody can give')
    assert.equal(state.recoveryOutcome.kind, 'auto-kept-changed')
    assert.equal(state.recoveryOutcome.auto, true)
    assert.equal(g.adapter.requests.length, 1, 'the delegated turn reaches the model')
    assert.equal((await g.host.store.load(g.agent.session.id)).generation, 2, 'the automatic decision is persisted')
  } finally { await g.close() }
})

test('a delegated session whose saved mode is incompatible fails the turn once instead of retrying', async () => {
  const { g } = await recoveryFixture(true, true)
  try {
    const state = g.host.state(g.agent)
    state.quarantine = { ...state.quarantine, active: { ...state.quarantine.active, mode: 'ptc' } }
    await send(g)
    await g.agent.whenIdle()
    const after = g.host.state(g.agent)
    assert.equal(after.recoveryOutcome, undefined)
    assert.equal(after.recovery.phase, 'pending')
    assert.equal(after.recovery.autoBlocked, true, 'a failed automatic keep is not retried on every turn')
    assert.match(after.recovery.error, /mode incompatible/)
    assert.equal(g.adapter.requests.length, 0, 'the turn does not reach the model without a decision')
  } finally { await g.close() }
})

test('delegation depth, not the agent identity, is what marks a session non-interactive', async () => {
  const { g } = await recoveryFixture(false, false)
  try {
    assert.equal(g.host.delegated(g.agent), false)
    assert.equal(g.host.delegated({ session: { header: { delegationDepth: 1 } } }), true)
    assert.equal(g.host.delegated({ session: { header: { delegationDepth: 0 } } }), false)
    assert.equal(g.host.delegated({ session: { header: {} } }), false)
    assert.equal(g.host.metadata(g.host.state(g.agent)).delegated, false)
  } finally { await g.close() }
})

test('a held send exposes its message for a resend and a cancelled wait stays answerable', async () => {
  const { g } = await recoveryFixture(false)
  try {
    const held = send(g)
    const id = await awaiting(g)
    const state = g.host.state(g.agent)
    assert.equal(state.recovery.phase, 'awaiting-choice')
    assert.equal(g.adapter.requests.length, 0, 'the model is not called before the choice')
    assert.match(state.deferredMessage.text, /hello/, 'the held message is remembered')
    assert.equal(g.host.metadata(state).recovery.deferredMessage.text, 'hello')
    g.agent.cancel({ kind: 'user' })
    await held.catch(() => {})
    const after = g.host.state(g.agent)
    assert.equal(after.recovery.phase, 'awaiting-choice', 'the prompt survives a cancelled turn')
    assert.equal(after.recovery.id, id, 'the same request id, so an open dialog stays valid')
    // Answering without a waiting turn must still work: the next send applies the choice.
    await g.host.resolveRecovery(g.agent.session.id, id, 'keep')
    assert.equal(g.host.state(g.agent).recovery.phase, 'keep')
    await send(g)
    assert.equal(g.host.state(g.agent).recovery, null)
    assert.equal(g.host.state(g.agent).deferredMessage, null)
    assert.equal(g.host.state(g.agent).recoveryOutcome.kind, 'kept-unchanged')
  } finally { await g.close() }
})

test('a delegated automatic keep is surfaced in the parent panel that is watching', async () => {
  const { g } = await recoveryFixture(true, true)
  try {
    const child = g.agent.session.id
    const parent = await g.ctx.agentLoop.create('parent-session', { provider: 'test', model: 'test' })
    // The parent records one catalog entry per delegated child; that is the linkage we bubble through.
    parent.session.append('subagent/catalog', { version: 0, childId: child, childCreatedAt: 1, mode: 'one-shot', label: 'probe' })
    await new Promise(resolve => setImmediate(resolve))
    await send(g)
    const parentState = g.host.state(parent)
    assert.deepEqual(parentState.childRecoveries.map(item => [item.sessionId, item.kind, item.label]), [[child, 'auto-kept-changed', 'probe']])
    assert.deepEqual(g.host.metadata(parentState).childRecoveries.map(item => item.kind), ['auto-kept-changed'])
    // Only the newest entry per child is kept, and human-confirmed outcomes never bubble.
    await send(g)
    assert.equal(g.host.state(parent).childRecoveries.length, 1)
  } finally { await g.close() }
})

test('strict recovery RPC codec accepts only documented choices', async () => {
  const { descriptors } = await import('../lib/contract.mjs')
  const descriptor = descriptors.find(d => d.method === 'resolveRecovery')
  assert.equal(descriptor.method,'resolveRecovery')
  assert.deepEqual(descriptor.parameters.map(p=>p.name), ['id','requestId','choice'])
  const codec = descriptor.parameters[2].codec.create()
  for (const value of ['keep','recapture']) assert.equal(codec.parse(value),value)
  for (const value of [null,undefined,'',true,'apply',{},[]]) assert.throws(()=>codec.parse(value))
})

test('recapture cancellation during committed write returns to pending, never stranded recapture', async () => {
  const { g } = await recoveryFixture(true)
  try {
    const pending = send(g), id = await awaiting(g)
    const save = g.host.store.save.bind(g.host.store)
    g.host.store.save = async record => { const saved = await save(record); g.agent.cancel({kind:'user'}); return saved }
    await g.host.resolveRecovery(g.agent.session.id,id,'recapture')
    await pending
    const state = g.host.state(g.agent)
    assert.equal(state.recovery.phase,'pending')
    assert.match(state.recovery.error,/cancelled after persistence/)
    assert.equal(state.recoveryOutcome,undefined)
    g.host.store.save = save
    const again = send(g), next = await awaiting(g)
    await g.host.resolveRecovery(g.agent.session.id,next,'recapture')
    await again
    assert.equal(state.recovery,null)
    assert.equal(state.recoveryOutcome.kind,'recaptured')
  } finally { await g.close() }
})

for (const choice of ['keep', 'recapture']) test(`recovery ${choice} tracks only its exact request usage`, async () => {
  const { g } = await recoveryFixture(true)
  try {
    g.adapter.usages = [{ inputTokens: 99, cacheReadTokens: 8 }, { inputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 4 }]
    const pending = send(g), id = await awaiting(g)
    await g.host.resolveRecovery(g.agent.session.id, id, choice)
    await pending
    const outcome = structuredClone(g.host.state(g.agent).recoveryOutcome)
    assert.equal(outcome.usageStatus, 'reported', JSON.stringify(outcome))
    assert.deepEqual(outcome.usage, { inputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 4 })
    g.adapter.usages = [{ inputTokens: 1000 }]
    await send(g)
    assert.deepEqual(g.host.state(g.agent).recoveryOutcome, outcome)
  } finally { await g.close() }
})
test('keep recovery rejected pre-step is not-called, missing usage is unavailable', async () => {
  for (const reject of [false, true]) {
    const { g } = await recoveryFixture()
    try {
      if (reject) g.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      const pending = send(g), id = await awaiting(g)
      await g.host.resolveRecovery(g.agent.session.id, id, 'keep'); await pending
      assert.equal(g.host.state(g.agent).recoveryOutcome.usageStatus, reject ? 'not-called' : 'unavailable')
      assert.equal(g.host.state(g.agent).recoveryUsage, null)
    } finally { await g.close() }
  }
})

test('recovery usage ignores auxiliary calls and diagnostics, rejects outer tools override', async () => {
  for (const override of [false, true]) {
    const { g } = await recoveryFixture()
    try {
      g.adapter.usages = [{ inputTokens: 7 }]
      if (override) g.ctx.on('system-prompt/assemble', async (_, context, next) => {
        const value = await next(); return context.signal ? { ...value, tools: [] } : value
      }, { prepend: true })
      g.ctx.on('agent/pre-step', async (payload, next) => {
        await g.host.probe(g.agent)
        await assemble(g)
        for await (const chunk of g.ctx.llm.stream({ provider: 'test', model: 'test', sessionId: g.agent.session.id, purpose: 'auxiliary', signal: payload.signal, messages: [{ role: 'user', content: 'auxiliary' }] })) {}
        return next()
      })
      const pending = send(g), id = await awaiting(g)
      await g.host.resolveRecovery(g.agent.session.id, id, 'keep'); await pending
      const outcome = g.host.state(g.agent).recoveryOutcome
      assert.equal(outcome.usageStatus, override ? 'not-called' : 'reported')
      if (!override) assert.deepEqual(outcome.usage, { inputTokens: 7 })
    } finally { await g.close() }
  }
})
test('same-turn second tool-loop step cannot overwrite first recovery usage', async () => {
  const { g } = await recoveryFixture()
  try {
    let calls = 0
    g.adapter.stream = async function* (options) {
      this.requests.push(options); calls++
      if (calls === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: 'call-alpha', name: 'alpha' }
        yield { type: 'tool-call-delta', index: 0, id: 'call-alpha', name: 'alpha', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-alpha', name: 'alpha', arguments: '{}' } }
      }
      yield { type: 'usage', usage: { inputTokens: calls === 1 ? 11 : 99, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: calls === 1 ? 'tool-calls' : 'stop' } }
    }
    const pending = send(g), id = await awaiting(g)
    await g.host.resolveRecovery(g.agent.session.id, id, 'keep'); await pending
    assert.equal(calls, 2)
    assert.deepEqual(g.host.state(g.agent).recoveryOutcome.usage, { inputTokens: 11 })
  } finally { await g.close() }
})
test('cancelled tracked stream retains reported counters without latest-session substitution', async () => {
  const { g } = await recoveryFixture()
  try {
    g.adapter.stream = async function* (options) {
      this.requests.push(options)
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 0 } }
      g.agent.cancel({ kind: 'user' })
      yield { type: 'finish', reason: { kind: 'aborted' } }
    }
    const pending = send(g), id = await awaiting(g)
    await g.host.resolveRecovery(g.agent.session.id, id, 'keep'); await pending
    assert.equal(g.host.state(g.agent).recoveryOutcome.usageStatus, 'reported')
    assert.deepEqual(g.host.state(g.agent).recoveryOutcome.usage, { inputTokens: 3 })
  } finally { await g.close() }
})

test('keep recovery regenerates current missing-tool notice without replaying old notice IDs', async () => {
  const { g } = await recoveryFixture()
  try {
    const state = g.host.state(g.agent)
    const stale = createUserMessage({source:{kind:'prompt-freeze',form:'notice'},content:[{type:'text',text:'stale apply'}]})
    state.quarantine = { ...state.quarantine, notice: {from:null,message:stale} }
    g.release()
    const pending = send(g), id = await awaiting(g)
    await g.host.resolveRecovery(g.agent.session.id,id,'keep')
    await pending
    const messages = g.adapter.requests.at(-1).messages
    assert(!messages.some(m=>m.id===stale.id))
    const registration = messages.find(m=>m.source?.form==='registration')
    assert(registration)
    assert.match(JSON.stringify(registration.content),/alpha/)
    assert.match(state.recoveryWarning,/discarded/)
    assert.equal(state.record.notice,null)
  } finally { await g.close() }
})
