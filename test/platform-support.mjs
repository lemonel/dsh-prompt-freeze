import { symlink } from 'node:fs/promises'

// POSIX file modes, directory fsync and hard links have no Windows equivalent.
export const posix = process.platform !== 'win32'
// Creating a symlink on Windows requires Developer Mode or elevation, and a directory
// target additionally needs the explicit 'dir' type that POSIX ignores. A platform that
// cannot express the case records a skip instead of failing the suite; any other error
// still surfaces.
export async function symlinkOrSkip(t, target, path, type = 'file') {
  try { await symlink(target, path, type); return true }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error.code)) throw error
    t.skip(`symlink creation unavailable (${error.code}); enable Developer Mode to run this case`)
    return false
  }
}
