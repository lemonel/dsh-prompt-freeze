import { errorCode, parseObject } from './backend-values.js'
import type { Store } from './core.js'
import type { AutoApplySetting, SessionSettings, SessionId } from './types.js'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { revision } from './core.js'
import { readRegular, renameWithRetry } from './storage.js'
import { parseThreshold } from './auto-apply.js'

export function validateSetting(value: unknown): AutoApplySetting {
  if (value !== null) {
    if (typeof value !== 'string') throw new Error('Expected settings string or null')
    parseThreshold(value)
  }
  return value
}
// Callers hold Store.serial(sessionId) for all reads and writes.
export class Settings {
  declare store: Store
  constructor(store: Store) { this.store = store }
  path(id: SessionId) { return join(this.store.directory, `settings-${revision(id)}.json`) }
  async read(id: SessionId): Promise<SessionSettings> {
    try {
      await this.store.safeDirectory()
      const data = parseObject((await readRegular(this.path(id))).text)
      if (data?.format !== 1 || data.profileIdentity !== this.store.profileIdentity || data.sessionId !== id || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Object.hasOwn(data, 'value')) throw new Error('Invalid auto-apply settings')
      const value = validateSetting(data.value)
      return { revision: data.revision, value }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { revision: 0, value: null }
      throw error
    }
  }
  async set(id: SessionId, value: AutoApplySetting, expectedRevision: number): Promise<SessionSettings> {
    validateSetting(value)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid settings revision')
    const current = await this.read(id)
    if (current.revision !== expectedRevision) throw new Error('Stale settings: refresh before saving again')
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('Settings revision exhausted')
    const next = { revision: current.revision + 1, value }
    await this.store.safeDirectory(true)
    const target = this.path(id), temporary = `${target}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { await file.writeFile(JSON.stringify({ format: 1, profileIdentity: this.store.profileIdentity, sessionId: id, ...next })); await file.sync() } finally { await file.close() }
      // Revalidate before replacement; corrupt or unsafe settings are never repaired implicitly.
      const latest = await this.read(id)
      if (latest.revision !== current.revision || latest.value !== current.value) throw new Error('Stale settings: refresh before saving again')
      await renameWithRetry(temporary, target)
      await this.store.syncDirectory()
      return next
    } finally { await unlink(temporary).catch(error => { if (errorCode(error) !== 'ENOENT') throw error }) }
  }
}
