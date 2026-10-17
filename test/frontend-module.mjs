import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const lib = new URL('../lib/', import.meta.url)

// Each harness gets an isolated graph, preserving its React mocks and module-local state.
export function frontendModules(react, globals = {}) {
  const cache = new Map()
  const context = vm.createContext({ ...globals })
  function load(name) {
    if (name === 'react' || name === 'react-dom') return react
    if (!name.startsWith('./')) return require(name)
    if (cache.has(name)) return cache.get(name).exports
    const module = { exports: {} }
    cache.set(name, module)
    const source = readFileSync(new URL(name, lib), 'utf8')
    const factory = vm.runInContext(`(function(require, module, exports) {\n${source}\n})`, context, { filename: name })
    factory(load, module, module.exports)
    return module.exports
  }
  return load
}
