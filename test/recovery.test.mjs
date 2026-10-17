import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symlinkOrSkip } from './platform-support.mjs'
import { Store, snapshot, clone } from '../lib/core.mjs'
import { checkpoint, matches, lastActivity } from '../lib/recovery.mjs'
import { PromptFreeze } from '../lib/host.mjs'
const root = await mkdtemp(join(tmpdir(), 'prompt-freeze-tests-'))
const dir = () => mkdtemp(join(root, 'recovery-'))
const cut = time => ({ session: { id: 's', createdAt: time }, inheritedEventCount: 0, events: [{ seq: 0, type: 'user/message', time, data: { source: { kind: 'user' } } }] })
const record = (store, c) => ({ format: 2, profileIdentity: store.profileIdentity, sessionId: 's', generation: 1, active: snapshot({ tools: [], sections: [] }, [], 'native', () => ''), notice: null, kept: null, checkpoint: checkpoint(c) })
function host(store, live, durable = live) {
  const agent = { session: { id: 's' }, status: 'idle', async runMaintenance(job) { return job() } }
  const persistence = durable && { async open() { return { header: durable.session, inheritedEventCount: durable.inheritedEventCount, async read() { return { events: durable.events } }, async close() {} } } }
  const h = Object.create(PromptFreeze.prototype)
  Object.assign(h, { store, states: new Map(), stopped: false, owner: { get: () => persistence, sessionQuery: { async readSession() { return clone(live) } }, sessions: { async flush() { return true } } } })
  return { h, agent }
}
test('hash validates complete prefix, identity and marker-only restart suffix', () => {
  const c = cut(100), cp = checkpoint(c)
  assert(matches(c, cp))
  const marker = { seq: 1, type: 'session/end-seed', time: 200, data: {} }
  assert(matches({ ...c, events: [...c.events, marker] }, cp))
  assert(!matches({ ...c, events: [...c.events, { ...marker, surfaceOp: 'append' }] }, cp))
  const rewrite = clone(c); rewrite.events[0].data.text = 'changed'; assert(!matches(rewrite, cp))
  assert(!matches({ ...c, session: { ...c.session, cwd: '/other' } }, cp))
})
test('activity excludes inherited, bookkeeping and plugin notices; unknown/future conservative', () => {
  const c = cut(100)
  c.events.push({ seq: 1, type: 'session/end-seed', time: 999, data: {} }, { seq: 2, type: 'user/message', time: 999, data: { source: { kind: 'tool-declaration-snapshot' } } })
  assert.equal(lastActivity(c, 1000), 100)
  c.events[0].time = 1001; assert.equal(lastActivity(c, 1000), null)
  c.events[0].time = undefined; assert.equal(lastActivity(c, 1000), null)
  c.inheritedEventCount = 3; assert.equal(lastActivity(c, 1000), 100)
})
for (const age of [3600000, 3600001, -1000, null]) test(`recovery mismatch activity age ${age}: quarantine without deletion`, async () => {
  const store = new Store(await dir()), now = Date.now(), old = cut(now - 9000000)
  const r = record(store, old); await store.save(r)
  const live = cut(age === null ? undefined : now - age)
  live.events[0].data.changed = true
  const { h, agent } = host(store, live)
  const originalNow = Date.now; Date.now = () => now
  try { await h.load(agent) } finally { Date.now = originalNow }
  assert.equal(h.state(agent).record, null)
  assert(h.state(agent).recoveryWarning); assert(await store.load('s'))
  assert.equal(h.state(agent).recovery.phase, 'pending')
  assert.deepEqual(h.state(agent).quarantine, r)
})
test('recovery metadata reports whether live frozen content still matches the saved snapshot', async () => {
  const store = new Store(await dir()), saved = record(store, cut(1))
  await store.save(saved)
  const f = host(store, cut(2))
  await f.h.load(f.agent)
  const state = f.h.state(f.agent)
  assert.equal(state.recovery.phase, 'pending')
  // Only meaningful while the user is choosing; it mirrors finishRecovery's kept-unchanged rule.
  assert.equal(f.h.metadata(state).recovery.frozenContentMatches, undefined)
  state.recovery = { ...state.recovery, phase: 'awaiting-choice' }
  assert.equal(f.h.metadata(state).recovery.frozenContentMatches, undefined, 'no live candidate yet')
  state.candidate = { revision: saved.active.revision }
  assert.equal(f.h.metadata(state).recovery.frozenContentMatches, true)
  state.candidate = { revision: 'f'.repeat(64) }
  assert.equal(f.h.metadata(state).recovery.frozenContentMatches, false)
})
for (const kind of ['tool-declaration-snapshot', 'cache-guard', 'prompt-freeze']) test(`${kind}: matching checkpoint restores pending messages byte-for-byte`, async () => {
  const store = new Store(await dir()), c = cut(1), saved = record(store, c)
  const target = { version: 1, entries: [] }
  const { revision } = await import('../lib/core.mjs')
  target.revision = revision(target)
  const message = form => ({ id: `historical-${form}`, role: 'user', source: { kind, form, summary: 'Original summary' }, content: [{ type: 'text', text: 'Original tool-declaration-snapshot payload' }] })
  saved.notice = { from: null, message: message('notice') }
  saved.registrationOutbox = [{ target, message: message('registration') }]
  await store.save(saved)
  const bytes = await readFile(store.path('s'), 'utf8')
  const f = host(store, c)
  await f.h.load(f.agent)
  assert.deepEqual(f.h.state(f.agent).record, saved)
  assert.equal(await readFile(store.path('s'), 'utf8'), bytes)
})

test('matching arbitrarily old record restores; no persistence and legacy never restore', async () => {
  const store = new Store(await dir()), c = cut(1); await store.save(record(store, c))
  let f = host(store, c); await f.h.load(f.agent); assert(f.h.state(f.agent).record)
  const recent = cut(Date.now()); await store.save(record(store, recent))
  f = host(store, recent, null); await f.h.load(f.agent); assert.equal(f.h.state(f.agent).record, null); assert(f.h.state(f.agent).recoveryWarning)
  await writeFile(store.path('s'), JSON.stringify({ format: 1, sessionId: 's' }))
  const legacyBytes = await readFile(store.path('s'), 'utf8')
  f = host(store, recent); await f.h.load(f.agent); assert.equal(f.h.state(f.agent).record, null)
  assert.equal(f.h.state(f.agent).recovery, undefined)
  assert.match(f.h.state(f.agent).error, /Legacy record has no recoverable snapshot/)
  assert.equal(await readFile(store.path('s'), 'utf8'), legacyBytes)
})
test('profiles isolate same session id even with explicit shared base', async () => {
  const base = await dir(), a = new Store(base, '/profile/a'), b = new Store(base, '/profile/b')
  await a.save(record(a, cut(1))); await b.save(record(b, cut(1)))
  assert.notEqual(a.path('s'), b.path('s')); await a.serial('s', () => a.delete('s')); assert(await b.load('s'))
})
test('symlinked storage roots are rejected before anything is created', async t => {
  const base = await dir(), target = await dir(), link = join(base, 'linked')
  if (!await symlinkOrSkip(t, target, link, 'dir')) return
  const unsafe = new Store(link)
  await assert.rejects(unsafe.save(record(unsafe, cut(1))), /Unsafe/)
  assert.deepEqual(await readdir(target), [])
})
test('symlinked ancestor storage stays usable; symlinked root and identity directory stay rejected', async t => {
  const real = await dir(), outer = await dir()
  const ancestor = join(outer, 'linked')
  if (!await symlinkOrSkip(t, real, ancestor, 'dir')) return
  // macOS /tmp -> private/tmp and similar environment links must not disable storage.
  const nested = new Store(join(ancestor, 'store'))
  await nested.save(record(nested, cut(1)))
  assert(await nested.load('s'))
  // The storage root this plugin owns is still rejected when it is a symlink.
  const rootLink = join(outer, 'root-link'); await symlink(real, rootLink, 'dir')
  const linkedRoot = new Store(rootLink)
  await assert.rejects(linkedRoot.save(record(linkedRoot, cut(1))), /Unsafe/)
  // A redirected identity directory must not store outside the owned root.
  const elsewhere = await dir(), escaped = new Store(join(outer, 'escaped'))
  await mkdir(escaped.base, { recursive: true })
  await symlink(elsewhere, escaped.directory, 'dir')
  await assert.rejects(escaped.save(record(escaped, cut(1))), /Unsafe|escaped scope/)
  assert.deepEqual(await readdir(elsewhere), [])
})
test('checkpoint waits whole flush, never overclaims racing append; failures preserve active', async () => {
  const store = new Store(await dir()), c = cut(100), f = host(store, c)
  const state = f.h.state(f.agent); state.loaded = true; state.record = record(store, c); state.record.checkpoint = null
  f.h.owner.sessions.flush = async () => { c.events.push({ seq: 1, type: 'tool/result', time: 200, data: {} }); return true }
  await store.serial('s', () => f.h.updateCheckpoint(state))
  assert.equal(state.record.checkpoint.count, 1)
  const old = state.record.checkpoint
  f.h.owner.sessions.flush = async () => false
  await store.serial('s', () => f.h.updateCheckpoint(state)); assert.deepEqual(state.record.checkpoint, old)
  f.h.owner.sessions.flush = async () => { throw new Error('late failure') }
  f.h.scheduleCheckpoint(state); await state.checkpointJob
  assert.match(state.checkpointError, /late failure/); assert.equal(state.error, null)
})


test('durable read error invalidates conservatively without deletion or baseline repair', async () => {
  const store = new Store(await dir()), c = cut(1); await store.save(record(store, c))
  const { h, agent } = host(store, c)
  h.owner.get = () => ({ async open() { throw new Error('EIO injected') } })
  await h.load(agent)
  assert.equal(h.state(agent).record, null); assert.equal(h.state(agent).error, null)
  assert(h.state(agent).recoveryWarning); assert(await store.load('s'))
})
test('running agent defers stale deletion and keeps conservative warning', async () => {
  const store = new Store(await dir()), c = cut(1); await store.save(record(store, c))
  const live = cut(2), { h, agent } = host(store, live)
  agent.status = 'running'; agent.runMaintenance = () => { throw new Error('must not run') }
  await h.load(agent); assert(h.state(agent).recoveryWarning); assert(await store.load('s'))
})
