// Windows semantics emulator for Linux regression runs — /proc implementation (diagnostic tool, not
// part of the npm package). prompt-freeze-win32-emulation.mjs is the portable default (Linux and macOS);
// this sibling exists as an independent second mechanism, because two implementations that agree are
// what keeps either one honest. Reach for the default unless you specifically want that cross-check.
//
// WHY: on Windows, FlushFileBuffers requires a handle with write access, so fsync() on a handle
// opened read-only always fails with EPERM (libuv maps ERROR_ACCESS_DENIED to UV_EPERM). Linux has
// no such rule, so a Linux-only suite cannot see that whole class of bug. This wrapper puts the
// rule back for this plugin's own code, and reports process.platform as 'win32' for it so the
// platform guards take their Windows branch.
//
// HOW:
//   1. process.platform becomes a getter that answers 'win32' only when the frame reading it lives
//      inside the plugin directory.
//   2. FileHandle.prototype.sync is wrapped: it reads the descriptor's real access mode from
//      /proc/self/fdinfo/<fd> and throws EPERM when the handle was opened read-only (flags & 3 == 0),
//      while write ('wx') and read-write ('r+') handles flush normally.
//
// SCOPE MATTERS: both checks look only at the frame that read process.platform / called sync, never
// at the whole stack. The host packages are always invoked *from* plugin code, so a whole-stack test
// matches them too; they then take their own Win32 path and fail to load their native Koffi module
// on Linux, producing failures that real Windows does not have (five of them, when this was written).
//
// REPRODUCE (from the repository root):
//   npm run build
//   NODE_OPTIONS="--import $PWD/test/tools/prompt-freeze-win32-emulation-proc.mjs" node --test test/*.test.mjs
//
// LIMITS: Linux-only (depends on /proc). It simulates only the two behaviours above: rename
// semantics, reparse points/junctions, sharing violations, MAX_PATH and read-only attributes are NOT
// emulated, so a green run here is not a substitute for a real Windows run. Taking a stack trace per
// platform read is fine for tests and must never reach production code.
//
// USAGE:
//   NODE_OPTIONS="--import $PWD/test/tools/prompt-freeze-win32-emulation-proc.mjs" node --test test/*.test.mjs
//   PROMPT_FREEZE_ROOT=/path/to/plugin   (defaults to the repository root next to this file)
import { open, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const plugin = process.env.PROMPT_FREEZE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const realPlatform = process.platform

// A silently inactive emulator would report a green run, so both prerequisites fail loudly.
const marker = join(plugin, 'lib', 'storage.mjs')
try { await stat(marker) }
catch { throw new Error(`prompt-freeze-win32-emulation-proc: no plugin at ${plugin} (expected ${marker}); set PROMPT_FREEZE_ROOT`) }

const probe = await open('/proc/self/status', 'r')
const prototype = Object.getPrototypeOf(probe)
const probeFlags = Number.parseInt(/^flags:\s*(\d+)/m.exec(await readFile(`/proc/self/fdinfo/${probe.fd}`, 'utf8'))[1], 8)
await probe.close()
if ((probeFlags & 3) !== 0) throw new Error('prompt-freeze-win32-emulation-proc: /proc/self/fdinfo did not report a read-only handle; Linux-only tool')

// The frame that read process.platform / called sync, skipping this harness itself. Matching on this
// file's own basename keeps the check exact now that a sibling entry exists.
const self = basename(fileURLToPath(import.meta.url))
const caller = () => {
  const lines = (new Error().stack ?? '').split('\n')
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].includes(self)) continue
    return lines[index]
  }
  return ''
}
const insidePlugin = () => caller().includes(plugin)

// The plugin's own test files also read as win32, and os.tmpdir() on win32 reads TEMP/TMP.
// Seed them from the real platform before the getter is installed.
const realTmp = tmpdir()
process.env.TEMP = realTmp
process.env.TMP = realTmp
process.env.USERPROFILE = homedir()

Object.defineProperty(process, 'platform', {
  configurable: true,
  get: () => (insidePlugin() ? 'win32' : realPlatform),
})

const original = prototype.sync

prototype.sync = async function sync() {
  if (!insidePlugin()) return original.call(this)
  const info = await readFile(`/proc/self/fdinfo/${this.fd}`, 'utf8')
  const flags = Number.parseInt(/^flags:\s*(\d+)/m.exec(info)[1], 8)
  if ((flags & 3) === 0) {
    const error = new Error('EPERM: operation not permitted, fsync')
    error.code = 'EPERM'
    throw error
  }
  return original.call(this)
}
