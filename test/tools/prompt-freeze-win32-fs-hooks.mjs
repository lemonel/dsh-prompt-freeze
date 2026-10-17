// Module hooks behind prompt-freeze-win32-emulation.mjs (the portable default entry).
//
// node:fs/promises is redirected, for modules inside the plugin directory only, to a shim whose
// open() returns the real FileHandle except that a read-only handle reports Windows semantics on
// sync() (EPERM: FlushFileBuffers requires a handle with write access). Write ('wx') and
// read-write ('r+') handles keep flushing normally, which is what the fix relies on.
//
// Redirecting the specifier is the mechanism that works: assigning to the fs.promises object does
// not reach ESM named imports of a builtin, because the namespace keeps its own binding. A loader
// hook instead decides per importing module, so scoping is exact and needs no stack inspection.
import { pathToFileURL } from 'node:url'

const SHIM = 'prompt-freeze-win32-shim:fs/promises'
let prefix = ''
let dependencies = ''

export function initialize(data) {
  prefix = pathToFileURL(data.plugin.endsWith('/') ? data.plugin : `${data.plugin}/`).href
  dependencies = `${prefix}node_modules/`
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs/promises' && context.parentURL?.startsWith(prefix) && !context.parentURL.startsWith(dependencies)) return { url: SHIM, shortCircuit: true }
  return nextResolve(specifier, context)
}

// The shim re-exports the builtin and shadows only open. Local exports win over `export *`.
const SOURCE = `
import * as real from 'node:fs/promises'
export * from 'node:fs/promises'
// O_ACCMODE is 3; a numeric flag without O_WRONLY/O_RDWR is read-only. String flags ('r', 'wx', 'r+').
const writable = flags => (typeof flags === 'number' ? (flags & 3) !== 0 : /[wa+]/.test(flags))
export async function open(path, flags, mode) {
  const handle = await real.open(path, flags, mode)
  if (writable(flags)) return handle
  handle.sync = async () => {
    const error = new Error('EPERM: operation not permitted, fsync')
    error.code = 'EPERM'
    throw error
  }
  return handle
}
`

export async function load(url, context, nextLoad) {
  if (url !== SHIM) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: SOURCE }
}
