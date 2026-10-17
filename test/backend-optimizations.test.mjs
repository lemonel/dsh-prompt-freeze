import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptFreeze } from '../lib/host.mjs'
import { Store, snapshot } from '../lib/core.mjs'
import { prepareRegistration, registrationState } from '../lib/registration.mjs'
import { descriptors } from '../lib/contract.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const agent = { session: { id: 's' }, status: 'idle' }
  const host = Object.create(PromptFreeze.prototype)
  Object.assign(host, { states: new Map(), stopped: false, store: new Store(join(tmpdir(), 'prompt-freeze-unused')), owner: { get: () => null, agents: new Map([['s', agent]]), tools: { get: () => true, modeFor: () => 'native' } } })
  const state = host.state(agent)
  state.loaded = true
  state.record = { active: snapshot({ sections: [], tools: [] }, [], 'native', () => ''), generation: 7, registrationOutbox: [], notice: null }
  return { host, state, agent }
}

test('checkpoint coalesces first pass and catches second and later pass tails', async () => {
  const { host, state } = fixture()
  let passes = 0, yielded = false
  host.updateCheckpoint = async () => {
    passes++
    if (passes > 1) assert(yielded)
    yielded = false
    setImmediate(() => { yielded = true })
    if (passes <= 3) host.scheduleCheckpoint(state)
  }
  host.scheduleCheckpoint(state)
  host.scheduleCheckpoint(state)
  await Promise.resolve()
  assert.equal(passes, 0)
  await state.checkpointJob
  assert.equal(passes, 4)
  assert.equal(state.checkpointDirty, false)
  assert.equal(state.checkpointJob, null)
})

test('checkpoint failure is bounded, retains dirty and retries on next event', async () => {
  const { host, state } = fixture()
  let calls = 0
  host.updateCheckpoint = async () => { calls++; host.scheduleCheckpoint(state); throw new Error('disk failure') }
  host.scheduleCheckpoint(state)
  await state.checkpointJob
  await tick(); await tick()
  assert.equal(calls, 1)
  assert.equal(state.checkpointDirty, true)
  assert.match(state.checkpointError, /disk failure/)
  host.updateCheckpoint = async () => { calls++; state.checkpointError = null }
  host.scheduleCheckpoint(state)
  await state.checkpointJob
  assert.equal(calls, 2)
  assert.equal(state.checkpointDirty, false)
  assert.equal(state.checkpointError, null)
})

for (const flag of ['stopped', 'disposed']) test(`checkpoint queued work respects ${flag}`, async () => {
  const { host, state } = fixture()
  host.updateCheckpoint = () => assert.fail('must not write')
  host.scheduleCheckpoint(state)
  if (flag === 'stopped') host.stopped = true
  else state.disposed = true
  await state.checkpointJob
})

test('established capture bypasses held queue; first capture still serializes and rechecks', async () => {
  const { host, state } = fixture()
  let release
  const held = host.store.serial('s', () => new Promise(resolve => { release = resolve }))
  await Promise.resolve()
  try {
    let done = false
    const capture = host.capture({ sessionId: 's' }).then(() => { done = true })
    await tick()
    assert(done, 'established baseline must not wait for queue')
    await capture
    const baseline = state.record
    state.record = null
    done = false
    const initial = host.capture({ sessionId: 's' }).then(() => { done = true })
    await tick()
    assert.equal(done, false)
    state.record = baseline // concurrent establishment must be checked inside queue
    release(); await held; await initial
    await state.checkpointJob
    assert.equal(state.record, baseline)
  } finally { release(); await held }
})

test('unchanged registration with empty outbox never queries or commits full record', async () => {
  const { host, state, agent } = fixture()
  state.record.registrationState = registrationState(state.record.active, host.owner.tools, agent)
  host.owner.sessionQuery = { readSession: () => assert.fail('history query'), readSurface: () => assert.fail('surface query') }
  host.commit = () => assert.fail('unnecessary commit')
  state.record.toJSON = () => assert.fail('whole record serialization')
  assert.equal(await prepareRegistration(host, state), null)
})

test('summary preserves metadata, freshly probes idle providers, never computes full view', async () => {
  const { host, state } = fixture()
  const large = 'huge metadata '.repeat(100000)
  state.record.active = snapshot({ sections: [{ name: 'custom', text: large }], tools: [{ name: 'large', description: large, parameters: { type: 'object' } }] }, [], 'native', () => large)
  state.record.kept = 'kept'
  state.recoveryWarning = 'warning'; state.checkpointError = 'checkpoint'; state.registrationError = 'registration'
  let probes = 0, reconciles = 0
  host.probe = async () => { state.candidate = { ...state.record.active, revision: `dynamic-${++probes}` } }
  host.reconcile = async () => { reconciles++ }
  const view = host.view
  host.view = () => assert.fail('summary must never build detailed view')
  const first = await host.summary('s'), second = await host.summary('s')
  assert.notEqual(first.candidate.revision, second.candidate.revision)
  assert.equal(reconciles, 2)
  assert.deepEqual(second.active, { revision: state.record.active.revision })
  for (const key of ['tools', 'sections', 'observation', 'diff', 'kept']) assert(!(key in second))
  assert(JSON.stringify(second).length < 2000)
  host.view = view
  const full = await host.status('s')
  for (const [key, value] of Object.entries(host.metadata(state))) assert.deepEqual(second[key], value)
  assert.equal(full.active.tools[0].description, large)
  assert(full.observation); assert(full.diff); assert.equal(full.kept, 'kept')
  assert.deepEqual(descriptors.map(d => d.method), ['status', 'applySnapshot', 'keep', 'summary', 'setAutoApply', 'resolveRecovery', 'acknowledgeObservation'])
})
