import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dshInternalPath } from './dsh-internal.mjs'
import { initialize, resolve as resolveHook } from './tools/prompt-freeze-win32-fs-hooks.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('CI resolves host plugins from this project, not a global DSH install', () => {
  if (process.env.DSH_PACKAGE_ROOT) return
  for (const name of ['@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway']) {
    const entry = dshInternalPath(name)
    const local = relative(join(root, 'node_modules'), entry)
    assert(!local.startsWith('..') && !isAbsolute(local), entry)
  }
})

test('explicit host root never falls back to locally or globally installed packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-freeze-host-root-'))
  const helper = new URL('./dsh-internal.mjs', import.meta.url).href
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', `import { dshInternalPath } from ${JSON.stringify(helper)}; ${code}`], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', DSH_PACKAGE_ROOT: directory },
  })
  const missing = run("dshInternalPath('@deepseek-ai/dsh-api-gateway')")
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Cannot locate DSH internal package/)
  const entry = join(directory, '@deepseek-ai', 'dsh-api-gateway', 'lib', 'index.js')
  await mkdir(resolve(entry, '..'), { recursive: true })
  await writeFile(entry, 'export const marker = true\n')
  const found = run("console.log(dshInternalPath('@deepseek-ai/dsh-api-gateway'))")
  assert.equal(found.status, 0, found.stderr)
  assert.equal(found.stdout.trim(), entry)
})

test('Windows emulation fs hook excludes project dependencies', async () => {
  initialize({ plugin: root })
  const builtin = { url: 'node:fs/promises' }
  const next = async () => builtin
  const local = await resolveHook('node:fs/promises', { parentURL: pathToFileURL(join(root, 'lib', 'storage.mjs')).href }, next)
  assert.equal(local.url, 'prompt-freeze-win32-shim:fs/promises')
  for (const parent of [join(root, 'node_modules', 'host', 'index.mjs'), join(root, 'node_modules', 'host', 'node_modules', 'nested', 'index.mjs')]) {
    assert.equal(await resolveHook('node:fs/promises', { parentURL: pathToFileURL(parent).href }, next), builtin)
  }
})

test('Windows emulation changes plugin platform but not its locally installed host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-freeze-emulator-scope-'))
  await mkdir(join(directory, 'lib'), { recursive: true })
  await mkdir(join(directory, 'node_modules', 'host'), { recursive: true })
  await writeFile(join(directory, 'lib', 'storage.mjs'), '')
  const code = 'export default process.platform\n'
  await writeFile(join(directory, 'lib', 'probe.mjs'), code)
  await writeFile(join(directory, 'node_modules', 'host', 'probe.mjs'), code)
  const plugin = pathToFileURL(join(directory, 'lib', 'probe.mjs')).href
  const host = pathToFileURL(join(directory, 'node_modules', 'host', 'probe.mjs')).href
  const emulator = new URL('./tools/prompt-freeze-win32-emulation.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--import', emulator, '--input-type=module', '-e', `console.log(JSON.stringify([(await import(${JSON.stringify(plugin)})).default, (await import(${JSON.stringify(host)})).default]))`], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PROMPT_FREEZE_ROOT: directory },
  })
  assert.equal(result.status, 0, result.stderr)
  const native = spawnSync(process.execPath, ['-p', 'process.platform'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(native.status, 0, native.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['win32', native.stdout.trim()])
})
