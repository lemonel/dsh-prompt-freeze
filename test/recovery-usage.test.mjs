import test from 'node:test'
import assert from 'node:assert/strict'
import { armUsage, bindUsage, claimUsage, counters, expireUsage, trackedStream } from '../lib/recovery-usage.mjs'
const setup = () => {
  const signal = new AbortController().signal
  const state = { agent: { status: 'running' }, recovery: { id: 'r' } }
  const assembly = { sections: [], tools: [], contexts: [], variables: {} }
  armUsage(state, assembly, { signal })
  state.recoveryOutcome = { id: 'r', kind: 'kept-unchanged', usageStatus: 'pending' }
  return { signal, state, assembly }
}
test('unclaimed next assembly expires once; cannot rearm same recovery', () => {
  const { signal, state, assembly } = setup()
  expireUsage(state, 'later assembly')
  armUsage(state, assembly, { signal })
  assert.equal(state.recoveryUsage, null)
  assert.equal(state.recoveryOutcome.usageStatus, 'not-called')
})
test('usage validates finite counters without fabricating missing cache counts', () => {
  assert.deepEqual(counters({ inputTokens: 0 }), { inputTokens: 0 })
  for (const value of [null, undefined, false, 1, 'usage', {}, [], { inputTokens: '1' }, { inputTokens: -1 }, { inputTokens: NaN }, { inputTokens: Infinity }, { inputTokens: 1, cacheReadTokens: -1 }, { inputTokens: 1, cacheWriteTokens: '2' }]) assert.equal(counters(value), null)
})
test('claimed stream latest usage wins, finalization detaches and later counters cannot replace it', async () => {
  const { signal, state } = setup()
  bindUsage(state, { signal, turn: 1, step: 1 }, { kind: 'enter' })
  const options = { signal, messages: [], tools: [] }
  const token = claimUsage(state, options)
  assert(token)
  assert.equal(claimUsage(state, options), null)
  for await (const chunk of trackedStream(state, token, async function* () {
    yield { type: 'usage', usage: { inputTokens: 2, cacheReadTokens: 4 } }
    yield { type: 'usage', usage: { inputTokens: 3 } }
    yield { type: 'finish' }
  })) {}
  assert.equal(state.recoveryUsage, null)
  assert.deepEqual(state.recoveryOutcome.usage, { inputTokens: 3 })
})
