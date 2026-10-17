// Checks that every symbol this plugin imports from @deepseek-ai/* exists in a given host tree.
//
// The plugin's suite proves behaviour; this proves the narrower, cheaper thing the version gate cares
// about: the exact named exports the runtime code binds to. Run it against any DSH install before
// widening peerDependencies, because a removed export fails at import time (loudly) while a changed
// option does not (see the 'both' tool mode in 0.2.1-alpha.x).
//
// Usage: node test/tools/prompt-freeze-host-surface.mjs <node_modules-root> [plugin-dir]
//   node test/tools/prompt-freeze-host-surface.mjs node_modules          (this plugin's own install)
//   node test/tools/prompt-freeze-host-surface.mjs /usr/lib/node_modules/@deepseek-ai/dsh/node_modules
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [rootArgument, pluginArgument] = process.argv.slice(2)
if (!rootArgument) {
  console.error('usage: prompt-freeze-host-surface.mjs <node_modules-root> [plugin-dir]')
  process.exit(2)
}
// createRequire rejects a relative path, so "node_modules" from the plugin root has to be resolved
// before it is handed over.
const root = resolve(rootArgument)
const plugin = pluginArgument ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(root, 'probe.cjs'))
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(@deepseek-ai\/[^']+)'/g

let checked = 0
const missing = []
// Runtime sources only: test/ imports extra packages that the published plugin never loads.
for (const name of (await readdir(join(plugin, 'lib'))).filter(entry => entry.endsWith('.mjs')).sort()) {
  const source = await readFile(join(plugin, 'lib', name), 'utf8')
  for (const [, clause, specifier] of source.matchAll(IMPORT)) {
    const wanted = clause.split(',').map(part => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    let exports
    try { exports = require(specifier) }
    catch (error) { missing.push(`${name} → ${specifier}: cannot load (${error.code ?? error.message})`); continue }
    const available = new Set([...Object.keys(exports), 'default'])
    const gone = wanted.filter(key => !available.has(key))
    checked += wanted.length
    if (gone.length) missing.push(`${name} → ${specifier}: missing ${gone.join(', ')}`)
    else console.log(`  ok  ${name} → ${specifier}: ${wanted.length} symbol(s)`)
  }
}

console.log(`\n${checked} symbol(s) checked against ${root}`)
for (const line of missing) console.log(`  MISSING  ${line}`)
process.exit(missing.length ? 1 : 0)
