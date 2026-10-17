import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptFreeze } from '../lib/host.mjs'
import { Store, snapshot, observe, observationDiff, rebaselineObservation, revision } from '../lib/core.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const render = assembly => assembly.sections.map(section => section.text).join('')
const renderContexts = assembly => assembly.contexts.map(context => ({ text: context.text }))
// harness:identity is a live exemption; tool:pipeline is an ordinary frozen section.
const sections = (liveText, frozenText) => [{ name: 'harness:identity', text: liveText }, { name: 'tool:pipeline', text: frozenText }]
const assembly = (workspace, variables, liveText = 'live A', frozenText = 'frozen A') => ({ sections: sections(liveText, frozenText), tools: [], contexts: [{ name: 'workspace', text: workspace }], variables })
const byName = observation => Object.fromEntries(observation.sections.map(section => [section.name, section]))

async function fixture() {
  const store = new Store(await mkdtemp(join(tmpdir(), 'prompt-freeze-acknowledge-')))
  const baseline = observe(assembly('/baseline', { mode: 'fast' }), render, renderContexts)
  const current = observe(assembly('/current', { mode: 'slow' }, 'live B', 'frozen B'), render, renderContexts)
  await store.save({ format: 2, profileIdentity: store.profileIdentity, sessionId: 's', generation: 3, active: snapshot({ tools: [], sections: [] }, [], 'native', () => ''), observation: baseline, checkpoint: null, notice: null, kept: 'saved-revision' })
  const agent = { session: { id: 's' }, status: 'idle' }
  const host = Object.create(PromptFreeze.prototype)
  Object.assign(host, { states: new Map(), stopped: false, store, owner: { get: () => null, agents: new Map([['s', agent]]), tools: { get: () => true, modeFor: () => 'native' } } })
  const state = host.state(agent)
  state.loaded = true
  state.record = await store.load('s')
  state.candidate = state.record.active
  state.observation = current
  // probe() is exercised through the real hook elsewhere; here it only refreshes the live observation.
  host.probe = async () => { state.observation = current; state.candidate = state.record.active; return state.record.active }
  return { store, host, state, baseline: clone(state.record.observation), current, original: clone(state.record) }
}

test('acknowledge adopts every live-tagged entry and leaves frozen differences for Apply', async () => {
  const f = await fixture()
  const view = await f.host.acknowledgeObservation('s', f.baseline.revision)
  const persisted = await new Store(f.store.base).load('s')
  const { observation: nextObservation, ...restNext } = persisted
  const { observation: originalObservation, ...restOriginal } = f.original
  // Only the observation document may change, and only inside its live-tagged entries.
  assert.deepEqual(restNext, restOriginal, 'no frozen field, generation, notice, registration or checkpoint may change')
  assert.deepEqual(Object.keys(nextObservation).sort(), Object.keys(originalObservation).sort())
  assert.deepEqual(nextObservation.tools, originalObservation.tools)
  for (const unit of ['contexts', 'variables']) assert.deepEqual(nextObservation[unit], f.current[unit], unit)
  assert.deepEqual(byName(nextObservation)['harness:identity'], byName(f.current)['harness:identity'], 'live section adopted')
  assert.deepEqual(byName(nextObservation)['tool:pipeline'], byName(originalObservation)['tool:pipeline'], 'frozen section untouched')
  assert.notEqual(byName(nextObservation)['tool:pipeline'].text, byName(f.current)['tool:pipeline'].text)
  assert.notEqual(nextObservation.revision, originalObservation.revision)
  const diff = observationDiff(persisted.observation, f.current)
  for (const unit of ['contexts', 'variables']) {
    assert.deepEqual(diff[unit].added, [])
    assert.deepEqual(diff[unit].removed, [])
    assert.deepEqual(diff[unit].changed, [])
  }
  // Differences this action must not swallow stay visible, and the live order is preserved.
  assert.deepEqual(diff.sections.changed.map(row => row.name), ['tool:pipeline'])
  assert.deepEqual(nextObservation.sections.map(section => section.name), f.current.sections.map(section => section.name))
  assert.deepEqual(view.observation.diff.sections.changed.map(row => row.name), ['tool:pipeline'])
  assert.equal(view.observation.diff.contexts.changed.length, 0)
  assert.equal(view.sessionId, 's'); assert.equal(view.generation, 3)
})

test('compact summary tags live changes per unit and stays compact', async () => {
  const f = await fixture()
  const summary = await f.host.summary('s')
  assert.deepEqual(summary.liveChanges.sections, { count: 1, names: ['harness:identity'] })
  assert.deepEqual(summary.liveChanges.contexts, { count: 1, names: ['workspace'] })
  assert.deepEqual(summary.liveChanges.variables, { count: 1, names: ['mode'] })
  for (const key of ['tools', 'sections', 'observation', 'diff', 'kept']) assert(!(key in summary), key)
  await f.host.acknowledgeObservation('s', f.baseline.revision)
  const after = await f.host.summary('s')
  // The frozen section still differs, but it is Apply-only and therefore never tagged live.
  assert.equal(after.liveChanges, null)
  const persisted = await new Store(f.store.base).load('s')
  assert.deepEqual(observationDiff(persisted.observation, f.current).sections.changed.map(row => row.name), ['tool:pipeline'])
})

test('stale, missing and recovery-owned baselines reject without rewriting storage', async () => {
  const f = await fixture()
  const bytes = await readFile(f.store.path('s'), 'utf8')
  await assert.rejects(f.host.acknowledgeObservation('s', 'f'.repeat(64)), /Stale observation baseline/)
  assert.equal(await readFile(f.store.path('s'), 'utf8'), bytes)
  const g = await fixture()
  g.state.record = { ...g.state.record, observation: undefined }
  await assert.rejects(g.host.acknowledgeObservation('s', g.baseline.revision), /No observation baseline/)
  const h = await fixture()
  h.state.recovery = { id: 'r', phase: 'pending' }
  await assert.rejects(h.host.acknowledgeObservation('s', h.baseline.revision), /Resolve snapshot recovery first/)
  assert.equal((await new Store(h.store.base).load('s')).observation.revision, h.baseline.revision)
})

test('repeating the acknowledgement rewrites nothing', async () => {
  const f = await fixture()
  const first = await f.host.acknowledgeObservation('s', f.baseline.revision)
  const manifest = await readFile(f.store.path('s'), 'utf8')
  const again = await f.host.acknowledgeObservation('s', first.observation.baseline.revision)
  assert.deepEqual(again.observation.baseline, first.observation.baseline)
  assert.equal(await readFile(f.store.path('s'), 'utf8'), manifest)
})

test('rebaseline helper adopts live entries only and refuses incomplete documents', () => {
  const baseline = observe(assembly('/a', { mode: 'fast' }), render, renderContexts)
  const current = observe(assembly('/b', { mode: 'slow' }, 'live B', 'frozen B'), render, renderContexts)
  const next = rebaselineObservation(baseline, current)
  assert.deepEqual(next.contexts, current.contexts)
  assert.deepEqual(next.variables, current.variables)
  assert.deepEqual(byName(next)['harness:identity'], byName(current)['harness:identity'])
  assert.deepEqual(byName(next)['tool:pipeline'], byName(baseline)['tool:pipeline'])
  assert.deepEqual(next.tools, baseline.tools)
  const { revision: hash, ...body } = next
  assert.equal(revision(body), hash)
  // A frozen section added or removed since the baseline keeps its diff.
  const grown = { ...assembly('/b', { mode: 'slow' }, 'live B'), sections: [...sections('live B', 'frozen B'), { name: 'tool:extra', text: 'new frozen' }] }
  const withAdded = rebaselineObservation(baseline, observe(grown, render, renderContexts))
  assert.equal(byName(withAdded)['tool:extra'], undefined)
  assert.deepEqual(observationDiff(withAdded, observe(grown, render, renderContexts)).sections.added.map(row => row.name), ['tool:extra'])
  const shrunk = observe({ ...assembly('/b', { mode: 'slow' }, 'live B'), sections: [sections('live B', 'frozen B')[0]] }, render, renderContexts)
  const withRemoved = rebaselineObservation(baseline, shrunk)
  assert(byName(withRemoved)['tool:pipeline'], 'a removed frozen section stays in the baseline')
  assert.deepEqual(observationDiff(withRemoved, shrunk).sections.removed.map(row => row.name), ['tool:pipeline'])
  assert.equal(rebaselineObservation(baseline, null), null)
  assert.equal(rebaselineObservation(null, current), null)
  assert.equal(rebaselineObservation({ ...baseline, contexts: undefined }, current), null)
  assert.equal(rebaselineObservation(baseline, { ...current, variables: undefined }), null)
  assert.equal(rebaselineObservation({ ...baseline, sections: undefined }, current), null)
})

test('one acknowledgement performs exactly one record commit', async () => {
  const f = await fixture()
  const list = async () => (await readdir(f.store.directory)).sort()
  const manifest = async () => JSON.parse(await readFile(f.store.path('s'), 'utf8'))
  const before = await list(), previousPayload = (await manifest()).payload
  const previousBytes = await readFile(f.store.payloadPath(previousPayload), 'utf8')
  const save = f.store.save.bind(f.store)
  let commits = 0
  f.store.save = async record => { commits++; return save(record) }
  await f.host.acknowledgeObservation('s', f.baseline.revision)
  f.store.save = save
  assert.equal(commits, 1, 'one acknowledgement is one commit')
  const after = await list()
  assert.equal(after.length, before.length + 1)
  assert(after.filter(name => !before.includes(name))[0].startsWith('payload-'), 'the only new file is the content-addressed payload')
  assert(!after.some(name => name.startsWith('settings-') || name.endsWith('.tmp')), 'no settings write and no leftover temporary file')
  assert.equal(await readFile(f.store.payloadPath(previousPayload), 'utf8'), previousBytes, 'the previous payload is retained unchanged')
  assert.notEqual((await manifest()).payload, previousPayload)
  // A second acknowledgement with nothing live left writes nothing at all.
  const owned = await new Store(f.store.base).load('s')
  let again = 0
  f.store.save = async record => { again++; return save(record) }
  await f.host.acknowledgeObservation('s', owned.observation.revision)
  f.store.save = save
  assert.equal(again, 0)
  assert.deepEqual(await list(), after)
})

test('observed variable order is host-independent', () => {
  const variables = { a: '1', B: '2', z: '3', 'ä': '4' }
  const observed = observe(assembly('/w', variables), render, renderContexts)
  // Code-unit order; a locale collation would reorder the same input (e.g. Swedish puts z before ä).
  assert.deepEqual(observed.variables.map(variable => variable.name), ['B', 'a', 'z', 'ä'])
  assert.notDeepEqual(Object.keys(variables).sort((left, right) => left.localeCompare(right, 'sv')), observed.variables.map(variable => variable.name))
})
