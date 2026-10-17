import test from 'node:test'
import assert from 'node:assert/strict'
import { PromptFreeze } from '../lib/host.mjs'

function fixture(get) {
  const host = Object.create(PromptFreeze.prototype)
  host.owner = { get }
  const state = { agent: { session: { id: 'estimate' }, status: 'idle' }, recovery: { id: 'r', phase: 'awaiting-choice' }, lastInputTokens: 999, autoApply: { inputTokens: 888 } }
  return { host, state, read: () => host.metadata(state).recovery }
}
const key = 'estimatedContextInputTokens'
test('optional projection absence, invalid shapes and failures omit the recovery estimate', () => {
  const invalid = [undefined, null, {}, { snapshot: 3 }, { snapshot() { throw Error('unloaded') } },
    ...[undefined, null, {}, { values: {} }, { values: { contextPressure: { pressureTokens: 456 } } }].map(value => ({ snapshot: () => value })),
    ...[undefined, null, '123', -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(projectedTokens => ({ snapshot: () => ({ values: { contextPressure: { projectedTokens, pressureTokens: 456 } } }) }))]
  for (const service of invalid) assert.equal(Object.hasOwn(fixture(() => service).read(), key), false)
  assert.equal(Object.hasOwn(fixture(() => { throw Error('missing') }).read(), key), false)
  assert.equal(Object.hasOwn(fixture(undefined).read(), key), false)
})
test('metadata reads current projection each time, includes zero, drops unloaded values and never mutates state', async () => {
  let tokens = 1234, service, calls = 0
  const f = fixture(name => { assert.equal(name, 'sessionProjections'); return service })
  service = { snapshot(session, keys) { calls++; assert.equal(session, f.state.agent.session); assert.deepEqual(keys, ['contextPressure']); return { values: { contextPressure: { projectedTokens: tokens, pressureTokens: 9999 } } } } }
  const before = structuredClone(f.state)
  assert.equal(f.read()[key], 1234)
  tokens = 0; assert.equal(f.read()[key], 0)
  tokens = 4567; assert.equal(f.read()[key], 4567)
  assert.equal(calls, 3)
  assert.deepEqual(f.state, before)
  service = { snapshot: () => ({ values: {} }) }; assert.equal(Object.hasOwn(f.read(), key), false)
  service = undefined; assert.equal(Object.hasOwn(f.read(), key), false)
  f.host.refreshStatus = async () => f.state
  assert.equal(Object.hasOwn((await f.host.summary('estimate')).recovery, key), false)
  for (const phase of ['pending', 'keep', 'recapture']) {
    f.state.recovery.phase = phase
    f.host.owner.get = () => { throw Error('must not query outside awaiting-choice') }
    assert.deepEqual(f.read(), { id: 'r', phase })
  }
  f.state.recovery = null; assert.equal(f.read(), null)
})
