import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { posix, symlinkOrSkip } from './platform-support.mjs'
import { Store } from '../lib/core.mjs'
import { Settings } from '../lib/settings.mjs'
import { Config } from '../lib/index.mjs'
import { descriptors } from '../lib/contract.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-freeze-settings-'))
  const store = new Store(directory), settings = new Settings(store)
  const set = (id, value, revision) => store.serial(id, () => settings.set(id, value, revision))
  return { directory, store, settings, set }
}
test('default config, nullable codec, missing settings, CAS and persistent reset prevent ABA', async () => {
  assert.equal(Config({}).autoApplyBelow, '24K')
  const codec = descriptors.find(d => d.method === 'setAutoApply').parameters[1].codec.create()
  for (const value of [null, '', '24K']) assert.equal(codec.parse(value), value)
  for (const value of [undefined, false, 24]) assert.throws(() => codec.parse(value))
  const { store, settings, set } = await fixture()
  assert.deepEqual(await settings.read('s'), { revision: 0, value: null })
  assert.deepEqual(await set('s', '1M', 0), { revision: 1, value: '1M' })
  await assert.rejects(set('s', '', 0), /Stale settings/)
  assert.deepEqual(await set('s', null, 1), { revision: 2, value: null })
  await assert.rejects(set('s', '2K', 0), /Stale settings/)
  assert.deepEqual(await new Settings(store).read('s'), { revision: 2, value: null })
  // Windows reports no POSIX permission bits for this file.
  if (posix) assert.equal((await stat(settings.path('s'))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(store.directory), [basename(settings.path('s'))])
  const races = await Promise.allSettled([set('s', '', 2), set('s', '2K', 2)])
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1)
})
test('post-rename durability failure retains advanced version and rejects stale retry', async () => {
  const { store, settings, set } = await fixture()
  await set('s', '24K', 0)
  const sync = store.syncDirectory.bind(store)
  store.syncDirectory = async () => { throw new Error('directory fsync failed') }
  await assert.rejects(set('s', '', 1), /fsync failed/)
  assert.deepEqual(await settings.read('s'), { revision: 2, value: '' })
  store.syncDirectory = sync
  await assert.rejects(set('s', '1M', 1), /Stale settings/)
  assert.deepEqual(await set('s', null, 2), { revision: 3, value: null })
})

test('settings isolate sessions and profiles and reject invalid values', async () => {
  const { directory, store, settings, set } = await fixture()
  await set('s', '', 0)
  assert.deepEqual(await settings.read('other'), { revision: 0, value: null })
  assert.deepEqual(await new Settings(new Store(directory, '/different-profile')).read('s'), { revision: 0, value: null })
  for (const value of [undefined, 1, false, '0', '-2K', 'NaN']) await assert.rejects(set('s', value, 1))
  assert.deepEqual(await settings.read('s'), { revision: 1, value: '' })
})
test('corrupt settings are never overwritten', async () => {
  const { store, settings, set } = await fixture()
  await store.safeDirectory(true)
  const target = settings.path('s')
  await writeFile(target, '{broken')
  await assert.rejects(settings.read('s'))
  await assert.rejects(set('s', null, 0))
  assert.equal(await readFile(target, 'utf8'), '{broken')
})
test('symlink settings are never overwritten', async t => {
  const { directory, store, settings, set } = await fixture()
  await store.safeDirectory(true)
  const target = settings.path('s'), outside = join(directory, 'outside')
  await writeFile(outside, 'untouched')
  if (!await symlinkOrSkip(t, outside, target)) return
  await assert.rejects(settings.read('s'))
  await assert.rejects(set('s', null, 0))
  assert.equal(await readFile(target, 'utf8'), 'untouched')
})
