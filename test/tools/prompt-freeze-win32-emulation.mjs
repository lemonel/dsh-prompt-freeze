// Windows semantics emulator for Linux AND macOS regression runs (diagnostic tool, not part of the
// npm package). Portable default; prompt-freeze-win32-emulation-proc.mjs is the Linux-only /proc
// implementation kept as an independent cross-check.
//
// WHY: on Windows, FlushFileBuffers requires a handle with write access, so fsync() on a handle
// opened read-only always fails with EPERM (libuv maps ERROR_ACCESS_DENIED to UV_EPERM). Neither
// Linux nor macOS has that rule, so a POSIX-only suite cannot see that whole class of bug.
//
// HOW: two independent Windows behaviours are emulated.
//   1. process.platform answers 'win32' only when the frame reading it lives inside the plugin
//      directory, so the plugin's platform guards take their Windows branch.
//   2. node:fs/promises is redirected, for modules inside the plugin directory only, to the shim in
//      prompt-freeze-win32-fs-hooks.mjs: real FileHandle, except that a handle opened read-only
//      throws EPERM on sync(), while write ('wx') and read-write ('r+') handles flush normally.
//      The redirect (module.register) is the only mechanism that works — assigning to the
//      fs.promises object never reaches ESM named imports of a builtin, because the namespace keeps
//      its own binding — and it scopes by importing module instead of by stack depth.
//
// SCOPE MATTERS: a whole-stack test for "is this the plugin" also matches the host packages, which
// are always invoked *from* plugin code; they then take their own Win32 path and fail to load their
// native Koffi module off Windows, producing failures that real Windows does not have (five of them,
// when this was written). The /proc sibling needs that stack check for sync() too; here only
// process.platform does, because the file API is scoped by the loader.
//
// REPRODUCE (from the repository root):
//   npm run build
//   NODE_OPTIONS="--import $PWD/test/tools/prompt-freeze-win32-emulation.mjs" node --test test/*.test.mjs
//
// LIMITS: it simulates only the two behaviours above: rename semantics, junctions/reparse points,
// sharing violations, MAX_PATH and read-only attributes are NOT emulated, so a green run here is not
// a substitute for a real Windows run. The stack trace per platform read is test-only and must never
// reach production code. Verified on Linux; macOS was not executed, but nothing here touches /proc or
// any other platform-specific interface (node:module, node:path, node:url, node:os only).
//
// USAGE:
//   NODE_OPTIONS="--import $PWD/test/tools/prompt-freeze-win32-emulation.mjs" node --test test/*.test.mjs
//   PROMPT_FREEZE_ROOT=/path/to/plugin   (defaults to the repository root next to this file)
import { register } from 'node:module'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const plugin = process.env.PROMPT_FREEZE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const realPlatform = process.platform

// A silently inactive emulator would report a green run, so the prerequisite fails loudly.
const marker = join(plugin, 'lib', 'storage.mjs')
try { await stat(marker) }
catch { throw new Error(`prompt-freeze-win32-emulation: no plugin at ${plugin} (expected ${marker}); set PROMPT_FREEZE_ROOT`) }

// The plugin's own test files also read as win32, and os.tmpdir() on win32 reads TEMP/TMP.
// Seed them from the real platform before the getter is installed.
const realTmp = tmpdir()
process.env.TEMP = realTmp
process.env.TMP = realTmp
process.env.USERPROFILE = homedir()

register(new URL('./prompt-freeze-win32-fs-hooks.mjs', import.meta.url), import.meta.url, { data: { plugin } })

// The frame that read process.platform, skipping this harness itself. Matching on this file's own
// basename keeps the check exact if either entry file is renamed.
const self = basename(fileURLToPath(import.meta.url))
const caller = () => {
  const lines = (new Error().stack ?? '').split('\n')
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].includes(self)) continue
    return lines[index]
  }
  return ''
}

Object.defineProperty(process, 'platform', {
  configurable: true,
  get: () => (caller().includes(plugin) ? 'win32' : realPlatform),
})
