import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Use the tested project's dependencies, never an unrelated global DSH install.
// An explicit override remains authoritative for isolated host-layout tests.
const roots = [process.env.DSH_PACKAGE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')]

// Two layouts are in the wild: a global install nests the host's own dependencies under the host
// package (`root/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm`), while a flat `npm install`
// hoists them next to it (`root/@deepseek-ai/dsh-llm`). CI and a contributor's first `npm install`
// both produce the flat one, so both are tried.
function* candidates(root, name) {
  const parts = name.split('/')
  yield join(root, '@deepseek-ai', 'dsh', 'node_modules', ...parts, 'lib', 'index.js')
  yield join(root, ...parts, 'lib', 'index.js')
}

export function dshInternalPath(name) {
  for (const root of roots) {
    for (const path of candidates(root, name)) if (existsSync(path)) return path
  }
  throw new Error(`Cannot locate DSH internal package ${name}; set DSH_PACKAGE_ROOT. Tried: ${roots.join(', ')}`)
}
export const dshInternal = async name => import(pathToFileURL(dshInternalPath(name)).href)

// Host packages are not uniform: most default-export the plugin, while the 0.2.1 line exports named
// members only ({ name, apply, Config }). Load whichever shape the tree provides.
export async function dshPlugin(name) {
  const module = await dshInternal(name)
  return module.default ?? module
}
