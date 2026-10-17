import { errorCode, isObject } from './backend-values.js'
import type { Checkpoint } from './types.js'
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { open, lstat, link, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

export const payloadHash = (text: string): string => createHash('sha256').update(text).digest('hex')
export function freezeRecord<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecord(child)
    Object.freeze(value)
  }
  return value
}
export function validateCheckpoint(cp: unknown): Checkpoint | null {
  if (cp === null) return null
  if (!isObject(cp) || typeof cp.count !== 'number' || !Number.isSafeInteger(cp.count) || cp.count < 0 || typeof cp.inheritedEventCount !== 'number' || !Number.isSafeInteger(cp.inheritedEventCount) || cp.inheritedEventCount < 0 || cp.inheritedEventCount > cp.count || typeof cp.hash !== 'string' || !/^[a-f0-9]{64}$/.test(cp.hash) || typeof cp.time !== 'number' || !Number.isFinite(cp.time) || cp.time < 0) throw new Error('Invalid checkpoint; explicit baseline required')
  // Copy only checkpoint fields: arbitrary caller properties must not enlarge manifests.
  return { count: cp.count, inheritedEventCount: cp.inheritedEventCount, hash: cp.hash, time: cp.time }
}
export async function regularStat(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe snapshot file')
  return stat
}
export const sameFile = (a: Stats, b: Stats): boolean => (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => a[key] === b[key])
// FAT/exFAT and some network filesystems report ino === 0 (occasionally dev === 0), where two
// different files can compare equal. Identity is only proven when the volume reports both.
export const identifiableFile = (stat: Stats): boolean => !!stat && !!stat.ino && !!stat.dev
// Windows can briefly refuse a replacing rename while an indexer or scanner holds the target
// open (EPERM/EBUSY/EACCES). A failed rename left the target untouched, so repeating the same
// atomic replacement is safe; every other error still surfaces immediately.
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES'])
export async function renameWithRetry(from: string, to: string, { attempts = 5, delayMs = 20, renameFile = rename } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await renameFile(from, to) }
    catch (error) {
      if (attempt >= attempts || !RENAME_RETRY.has(errorCode(error) ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt))
    }
  }
}
// Re-establish durability for an already published payload: the bytes must still hash to the
// address, and the existing file is reused rather than replaced.
export async function verifyReferencePayload(path: string, hash: string, syncDirectory: () => Promise<void>) {
  const { text } = await readRegular(path)
  if (payloadHash(text) !== hash) throw new Error('Payload integrity failure')
  await writePayload(path, text, hash, syncDirectory)
  return await regularStat(path)
}
export async function readRegular(path: string) {
  await regularStat(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Unsafe snapshot file')
    return { text: await file.readFile('utf8'), stat }
  } finally { await file.close() }
}
// A renamed or linked entry is not durable until its directory entry reaches storage.
// Windows cannot open a directory handle for fsync, so entry durability there belongs to
// NTFS metadata journaling — the same assumption the host's own storage, session
// persistence and attachment store already make. The platform parameter is that check.
export async function fsyncDirectory(path: string, platform = process.platform) {
  if (platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
// Re-establishing durability for an address that already exists is different from publishing:
// Windows needs a handle with write access before FlushFileBuffers succeeds, so a read-only
// handle always fails with EPERM there, while POSIX happily fsyncs an O_RDONLY descriptor.
// A read-only volume or attribute cannot hand out a writable handle at all; the bytes were just
// hash-verified, so that flush is skipped rather than failing the caller. Every other error,
// including all POSIX failures, still surfaces: durability is never silently dropped elsewhere.
const UNFLUSHABLE_HANDLE = new Set(['EACCES', 'EPERM', 'EROFS'])
export async function syncExistingFile(path: string, { platform = process.platform, openFile = open } = {}) {
  try {
    const file = await openFile(path, (platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
    try { await file.sync(); return true } finally { await file.close() }
  } catch (error) {
    if (platform === 'win32' && UNFLUSHABLE_HANDLE.has(errorCode(error) ?? '')) return false
    throw error
  }
}
// Publish with link (not rename): an existing content address is never overwritten.
// Volumes without hard links (exFAT, FAT32, SMB) fall back to an atomic same-directory
// rename, reached only after the address is proven absent, so a verified payload is
// never replaced by different bytes.
export async function writePayload(path: string, text: string, hash: string, syncDirectory: () => Promise<void>, linkFile = link, flushExisting = syncExistingFile) {
  const verify = async () => {
    const existing = await readRegular(path)
    if (payloadHash(existing.text) !== hash) throw new Error('Payload integrity failure')
    await flushExisting(path)
    await syncDirectory()
    return existing.stat
  }
  try { return await verify() } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(text); await file.sync() } finally { await file.close() }
    try { await linkFile(temporary, path) }
    catch (error) {
      if (errorCode(error) === 'EEXIST') return await verify()
      // The failed link published nothing: reuse a concurrently created, verified
      // address, otherwise publish by rename. Different content still fails closed.
      try { return await verify() } catch (inner) { if (errorCode(inner) !== 'ENOENT') throw inner }
      await renameWithRetry(temporary, path)
    }
    await syncDirectory()
    return await regularStat(path)
  } finally { await unlink(temporary).catch(error => { if (errorCode(error) !== 'ENOENT') throw error }) }
}
