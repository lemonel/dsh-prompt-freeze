import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, lstat, rename, readdir, utimes, open, link } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posix, symlinkOrSkip } from './platform-support.mjs'
import { Store, snapshot, revision, clone } from '../lib/core.mjs'
import { fsyncDirectory, identifiableFile, payloadHash, renameWithRetry, syncExistingFile, writePayload } from '../lib/storage.mjs'
const cp = n => ({ count: n, inheritedEventCount: 0, hash: String(n % 10).repeat(64), time: 1000 + n })
const make = store => ({ format: 2, profileIdentity: store.profileIdentity, sessionId: 's', generation: 1, active: snapshot({ tools: [], sections: [] }, [], 'native', () => ''), checkpoint: cp(10), notice: null, kept: null })
const setup = async () => new Store(await mkdtemp(join(tmpdir(), 'prompt-freeze-storage-')))
const manifest = async store => JSON.parse(await readFile(store.path('s'), 'utf8'))

test('v2 load does not rewrite; explicit checkpoint migrates and preserves complete payload', async () => {
  const store = await setup(), r = make(store)
  const target = { version: 1, entries: [] }; target.revision = revision(target)
  const message = (id, form) => ({ id, role: 'user', source: { kind: 'prompt-freeze', form, summary: 'exact summary' }, content: [{ type: 'text', text: 'unicode 原文 '.repeat(1000) }] })
  r.notice = { from: r.active, message: message('notice-id', 'notice') }
  r.registrationState = target
  r.registrationOutbox = Array.from({ length: 50 }, (_, i) => ({ target, message: message(`registration-${i}`, 'registration') }))
  await store.safeDirectory(true)
  const original = JSON.stringify(r)
  await writeFile(store.path('s'), original)
  let owned = await store.load('s')
  assert.equal(await readFile(store.path('s'), 'utf8'), original)
  assert.equal((await readdir(store.directory)).length, 1)
  owned = await store.saveCheckpoint(owned, cp(11))
  const first = await manifest(store), path = store.payloadPath(first.payload), before = await lstat(path), bytes = await readFile(path, 'utf8')
  assert.equal(first.format, 3); assert(!Object.hasOwn(JSON.parse(bytes), 'checkpoint'))
  for (let n = 12; n < 32; n++) {
    owned = await store.saveCheckpoint(owned, cp(n))
    assert.equal(JSON.stringify(await manifest(store)).length, JSON.stringify(first).length)
  }
  assert.equal((await lstat(path)).mtimeMs, before.mtimeMs)
  assert.equal(await readFile(path, 'utf8'), bytes)
  assert.deepEqual(await new Store(store.base).load('s'), { ...r, checkpoint: cp(31) })
  assert.equal((await readdir(store.directory)).length, 2)
})

test('owned immutable binding avoids payload work; same-generation commits and unbound callers stay safe', async () => {
  const store = await setup(), input = make(store)
  const first = await store.save(input)
  assert.notEqual(first, input); assert(Object.isFrozen(first.active.tools))
  assert.throws(() => { first.active.mode = 'ptc' }, TypeError)
  const target = { version: 1, entries: [{ name: 'a', registered: false }] }; target.revision = revision(target)
  let second = await store.save({ ...first, registrationState: target })
  const hash = (await manifest(store)).payload
  // Fast checkpoint must not call save or serialize any payload object.
  const save = store.save
  store.save = () => assert.fail('full save called on owned checkpoint')
  second = await store.saveCheckpoint(second, cp(11))
  assert.equal((await manifest(store)).payload, hash)
  store.save = save
  const synthetic = clone(second); synthetic.kept = 'changed'
  await store.saveCheckpoint(synthetic, cp(12))
  assert.equal((await store.load('s')).kept, 'changed')
  assert.notEqual((await manifest(store)).payload, hash)
  // A stale owned object must never borrow the newer registration payload.
  const current = await store.load('s')
  await assert.rejects(store.saveCheckpoint(first, cp(13)), /Stale Store-owned/)
  assert.deepEqual(await store.load('s'), current)
  store.forget('s')
  let fullSaves = 0
  store.save = async function (record) { fullSaves++; return save.call(this, record) }
  await assert.rejects(store.saveCheckpoint(first, cp(14)), /Stale Store-owned/)
  await store.saveCheckpoint(clone(current), cp(14))
  assert.equal(fullSaves, 1)
})

for (const damage of ['missing', 'corrupt', 'symlink', 'wrong hash']) test(`${damage} payload fails closed on restart and checkpoint`, async t => {
  const store = await setup(), owned = await store.save(make(store)), m = await manifest(store)
  const path = store.payloadPath(m.payload)
  if (damage === 'corrupt') await writeFile(path, '{}')
  else if (damage === 'wrong hash') { m.payload = 'f'.repeat(64); await writeFile(store.path('s'), JSON.stringify(m)) }
  else {
    // Exact known file path, retain the blob for inspection rather than delete.
    assert.equal(path, join(store.directory, `payload-${m.payload}.json`))
    await rename(path, `${path}.retained`)
    if (damage === 'symlink' && !await symlinkOrSkip(t, `${path}.retained`, path)) return
  }
  await assert.rejects(new Store(store.base).load('s'))
  if (damage !== 'wrong hash') await assert.rejects(store.saveCheckpoint(owned, cp(11)))
})

test('blob durability and pre-switch manifest failures preserve old manifest; post-switch uncertainty exposed', async () => {
  for (const failAt of [1, 2]) {
    const store = await setup(), old = await store.save(make(store)), bytes = await readFile(store.path('s'), 'utf8')
    const sync = store.syncDirectory.bind(store); let calls = 0
    store.syncDirectory = async () => { if (++calls === failAt) throw new Error('injected fsync'); await sync() }
    await assert.rejects(store.save({ ...old, kept: 'next' }), /injected fsync/)
    const restored = await new Store(store.base).load('s')
    if (failAt === 1) { assert.equal(await readFile(store.path('s'), 'utf8'), bytes); assert.equal(restored.kept, null) }
    else assert.equal(restored.kept, 'next') // rename happened; rejection remains visible
  }
  const store = await setup(), old = await store.save(make(store)), bytes = await readFile(store.path('s'), 'utf8')
  store.writeManifest = async () => { throw new Error('pre-switch') }
  await assert.rejects(store.save({ ...old, kept: 'next' }), /pre-switch/)
  assert.equal(await readFile(store.path('s'), 'utf8'), bytes)
  assert.deepEqual(await new Store(store.base).load('s'), old)
})

for (const phase of ['before rename', 'after rename']) test(`checkpoint retries safely after failure ${phase}`, async () => {
  const store = await setup(), owned = await store.save(make(store))
  const write = store.writeManifest.bind(store), sync = store.syncDirectory.bind(store)
  if (phase === 'before rename') store.writeManifest = async () => { throw new Error('transient write') }
  else store.syncDirectory = async () => { throw new Error('transient sync') }
  await assert.rejects(store.saveCheckpoint(owned, cp(11)), /transient/)
  store.writeManifest = write; store.syncDirectory = sync
  const next = await store.saveCheckpoint(owned, cp(12))
  assert.deepEqual(await new Store(store.base).load('s'), next)
  assert.equal(next.checkpoint.count, 12)
})

test('stale rejection preserves current cache and uncertain retry refuses a different payload', async () => {
  const store = await setup(), first = await store.save(make(store))
  const second = await store.save({ ...first, kept: 'second' })
  await assert.rejects(store.saveCheckpoint(first, cp(11)), /Stale/)
  const current = await store.saveCheckpoint(second, cp(12))
  const write = store.writeManifest.bind(store)
  store.writeManifest = async () => { throw new Error('transient') }
  await assert.rejects(store.saveCheckpoint(current, cp(13)), /transient/)
  store.writeManifest = write
  const other = new Store(store.base)
  await other.save({ ...current, kept: 'external commit' })
  const bytes = await readFile(store.path('s'), 'utf8')
  await assert.rejects(store.saveCheckpoint(current, cp(14)), /payload mismatch/)
  assert.equal(await readFile(store.path('s'), 'utf8'), bytes)
})

test('reusing corrupt content address rejects rather than overwrites; delete retains blobs', async () => {
  const store = await setup(), r = make(store)
  await store.save(r)
  const path = store.payloadPath((await manifest(store)).payload)
  await writeFile(path, 'corrupt')
  await assert.rejects(store.save(r), /integrity/)
  assert.equal(await readFile(path, 'utf8'), 'corrupt')
  await store.delete('s')
  assert.equal(await store.load('s'), null)
  assert.equal(await readFile(path, 'utf8'), 'corrupt')
})

test('directory fsync skips Windows and still syncs POSIX directories', async () => {
  const store = await setup()
  await store.safeDirectory(true)
  await fsyncDirectory(store.directory)
  // Windows cannot open a directory handle, so the guard must not touch the path at all.
  await fsyncDirectory(join(store.directory, 'missing'), 'win32')
  // A real directory fsync is only expressible on POSIX; Windows cannot open the handle.
  if (posix) await fsyncDirectory(store.directory, 'darwin')
})

test('an existing payload flushes through a writable handle on Windows and tolerates read-only volumes', async () => {
  const store = await setup()
  await store.safeDirectory(true)
  const text = '{"payload":"flush"}', hash = payloadHash(text), path = store.payloadPath(hash)
  const sync = () => store.syncDirectory()
  await writePayload(path, text, hash, sync)
  const opened = []
  const tracking = async (target, flags, mode) => { opened.push(flags); return open(target, flags, mode) }
  // POSIX may fsync a read-only descriptor, so that stays the default there.
  if (posix) {
    assert.equal(await syncExistingFile(path, { openFile: tracking }), true)
    assert.equal(opened.at(-1) & constants.O_RDWR, 0)
  }
  // Windows needs write access for FlushFileBuffers: a read-only handle always fails with EPERM.
  assert.equal(await syncExistingFile(path, { platform: 'win32', openFile: tracking }), true)
  assert.equal(opened.at(-1) & constants.O_RDWR, constants.O_RDWR)
  // A volume that cannot hand out a writable handle skips the flush instead of failing.
  const denied = () => { const error = new Error('access denied'); error.code = 'EACCES'; throw error }
  assert.equal(await syncExistingFile(path, { platform: 'win32', openFile: denied }), false)
  // Only the Windows fallback is tolerant: every other platform surfaces the failure.
  await assert.rejects(syncExistingFile(path, { platform: 'linux', openFile: denied }), /access denied/)
  const missing = () => { const error = new Error('gone'); error.code = 'ENOENT'; throw error }
  await assert.rejects(syncExistingFile(path, { platform: 'win32', openFile: missing }), /gone/)
  // Re-verifying an existing address delegates its flush to that platform-aware helper.
  const flushed = []
  await writePayload(path, text, hash, sync, link, target => { flushed.push(target); return syncExistingFile(target) })
  assert.deepEqual(flushed, [path])
})

test('volumes without hard links publish by rename, reuse verified content, and never replace other bytes', async () => {
  const store = await setup()
  await store.safeDirectory(true)
  const text = '{"payload":true}', hash = payloadHash(text), path = store.payloadPath(hash)
  const sync = () => store.syncDirectory()
  const unsupported = () => { const error = new Error('hard links unsupported'); error.code = 'EPERM'; throw error }
  const temps = async () => (await readdir(store.directory)).filter(name => name.endsWith('.tmp'))
  await writePayload(path, text, hash, sync, unsupported)
  assert.equal(await readFile(path, 'utf8'), text)
  assert.deepEqual(await temps(), [])
  const published = await lstat(path)
  // An existing verified address is reused without rewriting the file.
  await writePayload(path, text, hash, sync, unsupported)
  assert.equal((await lstat(path)).mtimeMs, published.mtimeMs)
  // A concurrent hard-link winner is verified, not replaced.
  const exists = () => { const error = new Error('exists'); error.code = 'EEXIST'; throw error }
  await writePayload(path, text, hash, sync, exists)
  assert.equal(await readFile(path, 'utf8'), text)
  // Different bytes at the address fail closed and stay untouched.
  const foreign = store.payloadPath(payloadHash('other'))
  await writeFile(foreign, 'foreign')
  await assert.rejects(writePayload(foreign, text, hash, sync, unsupported), /Payload integrity failure/)
  assert.equal(await readFile(foreign, 'utf8'), 'foreign')
  assert.deepEqual(await temps(), [])
})

test('replacing renames retry briefly on Windows-style sharing failures', async () => {
  const calls = []
  const sequence = codes => async (from, to) => {
    calls.push([from, to])
    const code = codes.shift()
    if (code) { const error = new Error(`failed with ${code}`); error.code = code; throw error }
  }
  await renameWithRetry('a', 'b', { renameFile: sequence([]) })
  assert.equal(calls.length, 1, 'a successful rename is never repeated')
  calls.length = 0
  await renameWithRetry('a', 'b', { renameFile: sequence(['EPERM', 'EBUSY']), attempts: 4, delayMs: 0 })
  assert.equal(calls.length, 3, 'transient sharing failures are retried')
  calls.length = 0
  await assert.rejects(renameWithRetry('a', 'b', { renameFile: sequence(['EPERM', 'EPERM']), attempts: 2, delayMs: 0 }), /EPERM/)
  assert.equal(calls.length, 2, 'the attempt cap is respected')
  calls.length = 0
  await assert.rejects(renameWithRetry('a', 'b', { renameFile: sequence(['ENOENT']), delayMs: 0 }), /ENOENT/)
  assert.equal(calls.length, 1, 'unrelated errors surface immediately')
})

test('file identity needs real inode numbers, and unidentifiable volumes re-verify bytes', async () => {
  assert.equal(identifiableFile({ ino: 5, dev: 7 }), true)
  assert.equal(identifiableFile({ ino: 0, dev: 7 }), false)
  assert.equal(identifiableFile({ ino: 5, dev: 0 }), false)
  assert.equal(identifiableFile(undefined), false)
  // FAT/exFAT-style volume: a changed stat cannot prove the file changed, so the payload is
  // re-read and re-hashed instead of being trusted or rejected.
  const store = await setup(), owned = await store.save(make(store))
  const path = store.payloadPath((await manifest(store)).payload)
  const beyond = new Date(Date.now() + 60000)
  await utimes(path, beyond, beyond)
  store.identifiableFile = () => false
  await store.saveCheckpoint(owned, cp(11))
  assert.equal((await manifest(store)).checkpoint.count, 11)
  assert.equal(payloadHash(await readFile(path, 'utf8')), (await manifest(store)).payload)
  // The default rule still refuses a payload whose recorded identity changed.
  const other = await setup(), second = await other.save(make(other))
  const otherPath = other.payloadPath((await manifest(other)).payload)
  await utimes(otherPath, beyond, beyond)
  await assert.rejects(other.saveCheckpoint(second, cp(11)), /Payload changed since validation/)
})

test('every publication rename goes through the retrying helper', async () => {
  const source = async name => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')
  for (const name of ['core.mjs', 'settings.mjs']) {
    const text = await source(name)
    assert(text.includes('renameWithRetry('), name)
    assert(!text.includes('rename('), `${name} must not call rename directly`)
  }
  const storage = await source('storage.mjs')
  assert(storage.includes('export async function renameWithRetry'))
  assert(storage.includes('renameFile = rename'), 'the raw rename stays injectable inside the helper')
  assert.equal(storage.match(/rename\(/g), null, 'storage.mjs calls the injected rename, never a bare one')
})
