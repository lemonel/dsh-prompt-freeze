import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateVersion, validateContents } from './tools/prompt-freeze-release.mjs'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const tag = `v${manifest.version}`
const entries = [
  'package.json', 'README.md', 'README.en.md', 'LICENSE', 'screenshots.json',
  'locale/en.json', 'locale/zh.json', 'docs/trigger.png', 'docs/panel-en.png', 'docs/panel-zh.png',
  manifest.main, manifest.icon, ...Object.values(manifest.exports).filter(value => !value.includes('*')),
  ...manifest.dsh.bundle.patch, 'lib/host.mjs', 'lib/panel.cjs',
].map(path => `package/${path.replace(/^\.\//, '')}`)

test('release tag and both lockfile versions must agree with the package', () => {
  assert.equal(validateVersion(tag, manifest, lock), `lemonel-dsh-prompt-freeze-${manifest.version}.tgz`)
  for (const invalid of ['main', manifest.version, 'v9.9.9', `${tag};echo injected`]) {
    assert.throws(() => validateVersion(invalid, manifest, lock))
  }
  assert.throws(() => validateVersion(tag, manifest, { ...lock, version: '9.9.9' }))
  assert.throws(() => validateVersion(tag, manifest, { ...lock, packages: { '': { name: manifest.name, version: '9.9.9' } } }))
})

test('release version accepts an explicitly matched prerelease', () => {
  const prerelease = { ...manifest, version: '1.1.0-rc.1' }
  const prereleaseLock = { ...lock, version: prerelease.version, packages: { '': { name: manifest.name, version: prerelease.version } } }
  assert.equal(validateVersion('v1.1.0-rc.1', prerelease, prereleaseLock), 'lemonel-dsh-prompt-freeze-1.1.0-rc.1.tgz')
  const invalid = { ...prerelease, version: '1.1.0-01' }
  assert.throws(() => validateVersion('v1.1.0-01', invalid, { ...prereleaseLock, version: invalid.version, packages: { '': { name: invalid.name, version: invalid.version } } }), /leading zeros/)
})

test('release tarball must contain runtime entries, implementation, bundle and UI assets', () => {
  validateContents(entries, manifest, manifest)
  for (const missing of ['lib/index.mjs', 'lib/client.js', 'lib/host.mjs', 'lib/panel.cjs', 'bundles/prompt-freeze.patch.yml', 'docs/panel-en.png']) {
    assert.throws(() => validateContents(entries.filter(entry => entry !== `package/${missing}`), manifest, manifest), /Missing/)
  }
  assert.throws(() => validateContents(entries, { ...manifest, version: '9.9.9' }, manifest), /version differs/)
})

test('release tarball rejects development content and unsafe paths', () => {
  for (const unwanted of ['package/src/backend_index.ts', 'package/test/ci.test.mjs', 'package/node_modules/host/index.js', 'package/.github/workflows/release.yml', 'package/../secret', '/tmp/secret']) {
    assert.throws(() => validateContents([...entries, unwanted], manifest, manifest))
  }
})
