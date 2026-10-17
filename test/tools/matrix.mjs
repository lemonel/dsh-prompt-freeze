#!/usr/bin/env node
// Run the suite against several published DSH releases, one install each.
//
// Usage: node test/tools/matrix.mjs [dsh-version ...]
//        with no arguments: 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.4
//
// The host packages are ordinary devDependencies pinned to a single DSH line, so switching versions is
// just an install — no scratch directory, no copying the plugin next to a host tree, no
// DSH_PACKAGE_ROOT. This script only re-points those pins, installs, checks that every symbol the
// runtime imports still exists in that release, builds, and runs the suite.
//
// It rewrites package.json, so the original pins are restored afterwards — on failure too. The
// committed lockfile is deliberately left alone (`--no-package-lock`): it records the tree the default
// pins resolve to, and rewriting it per matrix row would leave a dirty tree behind every run.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_VERSIONS = ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.4']
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))

// cordis and schemastery version independently of the DSH line, so they keep a range carrying explicit
// prerelease branches: node-semver only admits a prerelease when some comparator shares its exact
// major.minor.patch tuple and itself carries a prerelease tag.
const COMPANION_RANGES = {
  '@deepseek-ai/cordis': '>=4.0.4 <5 || >=4.0.5-alpha.1 <4.0.6-0',
  '@deepseek-ai/schemastery': '>=3.18.4 <4 || >=3.18.5-alpha.1 <3.18.6-0',
}

const manifestPath = join(root, 'package.json')
const original = readFileSync(manifestPath, 'utf8')
const isHost = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

const run = (command, args) => spawnSync(command, args, {
  stdio: 'inherit', cwd: root, shell: process.platform === 'win32',
})

let status = 0
try {
  for (const version of (requested.length ? requested : DEFAULT_VERSIONS)) {
    const manifest = JSON.parse(original)
    const dev = {}
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      dev[name] = COMPANION_RANGES[name] ?? (isHost(name) ? version : range)
    }
    if (!Object.keys(dev).some((name) => isHost(name))) dev['@deepseek-ai/dsh'] = version
    manifest.devDependencies = dev
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const install = run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-package-lock'])
    if (install.status !== 0) { console.error(`[matrix] ${version}: install failed`); status = 1; continue }

    // Fail loudly on a silent fallback: npm can resolve a different release than the one asked for,
    // and a matrix that quietly tested rc.2 four times is worse than one that reports a failure.
    const landed = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
    if (landed !== version) { console.error(`[matrix] requested ${version} but @deepseek-ai/dsh@${landed} landed`); status = 1; continue }

    if (run('npm', ['run', 'build']).status !== 0) { console.error(`[matrix] ${version}: build failed`); status = 1; continue }
    // Cheap and independent of behaviour: every symbol the runtime imports must still exist in this
    // release, which is what a peer range is a promise about.
    if (run('node', ['test/tools/prompt-freeze-host-surface.mjs', join(root, 'node_modules'), root]).status !== 0) {
      console.error(`[matrix] ${version}: the imported symbol surface changed`)
      status = 1
      continue
    }
    const suite = run('node', ['--test', 'test/*.test.mjs'])
    console.log(`\n[matrix] DSH ${version}: ${suite.status === 0 ? 'PASS' : 'FAIL'}\n`)
    if (suite.status !== 0) status = 1
  }
} finally {
  writeFileSync(manifestPath, original)
}

process.exit(status)
