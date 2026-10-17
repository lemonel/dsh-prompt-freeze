import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { Store, snapshot, validateRecord, clone, observe, revision } from '../lib/core.mjs'
import { SOURCE_KIND, isSourceKind, STORAGE_DIRECTORY } from '../lib/identity.mjs'
test('product identity uses prompt-freeze while preserving durable compatibility', () => {
  assert.equal(SOURCE_KIND, 'prompt-freeze')
  assert.equal(STORAGE_DIRECTORY, 'cache-guard')
  for (const kind of ['prompt-freeze', 'cache-guard', 'tool-declaration-snapshot']) assert(isSourceKind(kind))
  for (const kind of ['user', '', null, undefined]) assert(!isSourceKind(kind))
})
const active = snapshot({ tools: [], sections: [] }, [], 'native', () => '')
import { registrationState } from '../lib/registration.mjs'
test('default storage uses cache-guard directory and exact profile identity', () => {
  // Expectations are built the way the Store builds them: the absolute profile path is what
  // participates in the identity hash, and it is separator- and drive-dependent on Windows.
  const profile = resolve('/profile/prompt-freeze-test')
  const store = new Store(undefined, '/profile/prompt-freeze-test')
  const identity = revision({ profile })
  assert.equal(store.profileIdentity, identity)
  assert.equal(store.base, resolve(join(profile, STORAGE_DIRECTORY)))
  assert.equal(store.directory, join(store.base, identity))
  assert.equal(store.path('a'), resolve(store.directory, `${revision('a')}.json`))
})

const good = { format: 2, profileIdentity: 'test', checkpoint: null, sessionId: 'a', generation: 1, active, notice: null, kept: null }
for (const kind of ['tool-declaration-snapshot', 'cache-guard', 'prompt-freeze']) test(`${kind}: pending notices and registration validate without rewriting content or IDs`, () => {
  const state = registrationState(active, { get: () => true }, {})
  const message = form => ({ id: `saved-${form}`, role: 'user', source: { kind, form, summary: 'Original summary' }, content: [{ type: 'text', text: 'Original tool-declaration-snapshot message content' }] })
  const record = { ...good, notice: { from: null, message: message('notice') }, registrationState: state, registrationOutbox: [{ target: state, message: message('registration') }] }
  const before = JSON.stringify(record)
  assert.equal(validateRecord(record, 'a'), record)
  assert.equal(JSON.stringify(record), before)
  for (const form of ['notice', 'registration']) {
    const invalid = clone(record)
    const target = form === 'notice' ? invalid.notice.message : invalid.registrationOutbox[0].message
    target.source.kind = 'unrelated'
    assert.throws(() => validateRecord(invalid, 'a'), /Invalid/)
  }
})

test('independent registration fields validate without changing snapshot revision', () => {
  const state = registrationState(active, { get: () => true }, {})
  const message = { id: 'reg', role: 'user', source: { kind: 'tool-declaration-snapshot', form: 'registration', summary: 'status' }, content: [{ type: 'text', text: 'status' }] }
  validateRecord({ ...good, registrationState: state, registrationOutbox: [{ target: state, message }] }, 'a')
  for (const bad of [null, {}, { ...state, revision: 'bad' }, { ...state, entries: [{ name: 'x', registered: 'yes' }] }]) assert.throws(() => validateRecord({ ...good, registrationState: bad }, 'a'), /egistration/)
  for (const bad of [null, {}, [{ target: state, message: { ...message, role: 'assistant' } }], [{ target: state, message }, { target: state, message }]]) assert.throws(() => validateRecord({ ...good, registrationOutbox: bad }, 'a'), /egistration/)
  assert.equal(good.active.revision, active.revision)
})
test('record validation rejects missing/null active and malformed tool/message/from even with valid hashes', () => {
  assert.equal(validateRecord(good, 'a'), good)
  for (const active of [null, undefined, [], {}, 'bad']) assert.throws(() => validateRecord({ ...good, active }, 'a'), /baseline|integrity/)
  const invalidTool = snapshot({ tools: [{ name: 'x', description: 'x', parameters: null }], sections: [] }, [], 'native', () => '')
  assert.throws(() => validateRecord({ ...good, active: invalidTool }, 'a'), /integrity/)
  const notice = { from: null, message: { id: 'notice', role: 'user', source: { kind: 'tool-declaration-snapshot', form: 'notice', summary: 'Changed' }, content: [{ type: 'text', text: 'delta' }] } }
  validateRecord({ ...good, notice }, 'a')
  for (const mutate of [n => delete n.from, n => n.from = {}, n => n.message.role = 'assistant', n => n.message.content = [], n => n.message.source.kind = 'user', n => n.message.id = '', n => n.message.content[0].text = 42]) {
    const bad = clone(notice); mutate(bad)
    assert.throws(() => validateRecord({ ...good, notice: bad }, 'a'), /baseline|integrity/)
  }
})


test('record boundary rejects malformed nested objects and never rewrites accepted records', () => {
  for (const value of [null, undefined, true, 1, 'record', [], {}]) assert.throws(() => validateRecord(value, 'a'))
  const notice = { from: null, message: { id: 'n', role: 'user', source: { kind: 'prompt-freeze', form: 'notice', summary: 'notice' }, content: [{ type: 'text', text: 'exact original' }] } }
  for (const source of [null, undefined, [], 'prompt-freeze', {}, { kind: 'prompt-freeze' }]) {
    assert.throws(() => validateRecord({ ...good, notice: { ...notice, message: { ...notice.message, source } } }, 'a'))
  }
  for (const observation of [true, [], 'observation', {}, { revision: 'bad', sections: null }]) assert.throws(() => validateRecord({ ...good, observation }, 'a'))
  const record = { ...good, notice }
  const before = JSON.stringify(record)
  assert.equal(validateRecord(record, 'a'), record)
  assert.equal(JSON.stringify(record), before)
})

test('named coverage requires layout while legacy snapshots remain readable', () => {
  const { revision: ignored, ...body } = clone(active)
  delete body.sectionLayout
  const malformed = { ...body, revision: revision(body) }
  assert.throws(() => validateRecord({ ...good, active: malformed }, 'a'), /layout/)
  delete body.coverage
  for (const legacy of [body, { ...body, sectionLayout: [] }]) {
    const record = { ...good, active: { ...legacy, revision: revision(legacy) } }
    assert.equal(validateRecord(record, 'a'), record)
  }
})

test('optional observation validates typed data and preserves undefined vs absent variables', () => {
  const observation = observe({ sections: [{ name: 'one', text: 'hello' }], tools: [], contexts: [], variables: { absentValue: undefined, empty: '' } }, a => a.sections[0].text, () => [])
  assert.equal(observation.variables.find(v => v.name === 'absentValue').defined, false)
  validateRecord({ ...good, observation }, 'a')
  for (const mutate of [o => o.sections[0].live = 'yes', o => o.sections[0].text = null, o => o.contexts.push({ name: 'bad', text: 2 }), o => o.variables[0].defined = null, o => o.variables[0].value = 'invalid undefined']) {
    const bad = clone(observation); mutate(bad); const { revision: ignored, ...body } = bad; bad.revision = revision(body)
    assert.throws(() => validateRecord({ ...good, observation: bad }, 'a'), /Observation integrity/)
  }
})
