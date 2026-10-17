import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Keep release checks dependency-free so a mistagged release fails before npm ci.
export function validateVersion(tag, manifest, lock) {
  assert.match(tag ?? '', /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, 'Expected a vX.Y.Z release tag (optionally with a prerelease suffix)')
  for (const identifier of tag.split('-').slice(1).join('-').split('.').filter(Boolean)) {
    assert(!/^0\d+$/.test(identifier), 'Numeric prerelease identifiers must not have leading zeros')
  }
  assert.equal(tag, `v${manifest.version}`, 'Release tag must match package.json version')
  assert.equal(lock.version, manifest.version, 'Lockfile version must match package.json')
  assert.equal(lock.packages?.['']?.version, manifest.version, 'Lockfile root version must match package.json')
  assert.equal(lock.name, manifest.name, 'Lockfile package name must match package.json')
  assert.equal(lock.packages?.['']?.name, manifest.name, 'Lockfile root name must match package.json')
  return `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
}

export function validateContents(entries, packed, manifest) {
  assert.equal(packed.name, manifest.name, 'Packed package name differs')
  assert.equal(packed.version, manifest.version, 'Packed package version differs')
  assert.deepEqual(packed.exports, manifest.exports, 'Packed entry points differ')
  assert.deepEqual(packed.dsh, manifest.dsh, 'Packed DSH manifest differs')
  const paths = new Set(entries.map(entry => entry.replace(/^package\//, '')))
  const required = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'screenshots.json', 'locale/en.json', 'locale/zh.json', 'docs/trigger.png', 'docs/panel-en.png', 'docs/panel-zh.png', packed.main, packed.icon, ...Object.values(packed.exports).filter(value => !value.includes('*')), ...packed.dsh.bundle.patch]
  for (const path of required) assert(paths.has(path.replace(/^\.\//, '')), `Missing release file: ${path}`)
  for (const entry of entries) {
    assert(entry.startsWith('package/') && !entry.split('/').includes('..'), `Unsafe archive path: ${entry}`)
    assert(!/^package\/(?:src|test|node_modules|\.github)(?:\/|$)/.test(entry), `Unexpected development file: ${entry}`)
  }
  // Transitive frontend/backend modules must be shipped too, not just entry stubs.
  assert(paths.has('lib/host.mjs'), 'Missing backend implementation')
  assert(paths.has('lib/panel.cjs'), 'Missing frontend implementation')
}

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function main() {
  const [command, tag, directory] = process.argv.slice(2)
  assert(['validate', 'verify'].includes(command), 'Usage: prompt-freeze-release.mjs validate <tag> | verify <tag> <directory>')
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  const filename = validateVersion(tag, manifest, lock)
  if (command === 'verify') {
    assert(directory, 'Tarball directory is required')
    const files = (await readdir(directory)).filter(file => file.endsWith('.tgz'))
    assert.deepEqual(files, [filename], 'Expected exactly the versioned release tarball')
    const archive = join(directory, filename)
    const entries = tar(['-tzf', archive]).trim().split(/\r?\n/)
    const packed = JSON.parse(tar(['-xOzf', archive, 'package/package.json']))
    validateContents(entries, packed, manifest)
    const built = (await readdir('lib')).map(file => `package/lib/${file}`).sort()
    const shipped = entries.filter(entry => entry.startsWith('package/lib/')).sort()
    assert.deepEqual(shipped, built, 'Tarball must include every built runtime file and no stale extras')
  }
  console.log(`Release ${command} passed: ${filename}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
