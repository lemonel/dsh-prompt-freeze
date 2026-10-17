import { errorCode, isObject, parseObject } from './backend-values.js'
import type { ObservationDiff, ObservationUnit, ObservationRow, FrozenSnapshot, NamedSectionsSnapshot, PromptAssembly, ToolSchema, ToolMode, Observation, SnapshotRecord, PayloadReference, Checkpoint, LoadedRecord, SessionId } from './types.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, unlink, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { validateRegistration } from './registration.js'
import { isSourceKind, STORAGE_DIRECTORY } from './identity.js'
import { freezeRecord, validateCheckpoint, payloadHash, readRegular, regularStat, sameFile, writePayload, fsyncDirectory, renameWithRetry, identifiableFile, verifyReferencePayload } from './storage.js'

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
export const revision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const SDK_NAMES = new Set(['tools:sdk', 'tools:ptc-only'])
export const LIVE_SECTION_NAMES = new Set(['plan:policy', 'team:policy', 'tool:structured_output', 'deployment:persona-prefix', 'deployment:persona-suffix', 'harness:identity', 'harness:source', 'app:web-surface'])
export const expandedCoverage = (snap: FrozenSnapshot | null | undefined): snap is NamedSectionsSnapshot => snap?.coverage === 'named-sections-v1'
function uniqueNames(sections: readonly unknown[]): string[] {
  const names: string[] = []
  for (const section of sections) {
    if (!isObject(section) || typeof section.name !== 'string' || !section.name.length) throw new Error('Duplicate or invalid system prompt section names; cannot safely freeze sections')
    names.push(section.name)
  }
  if (new Set(names).size !== names.length) throw new Error('Duplicate or invalid system prompt section names; cannot safely freeze sections')
  return names
}
export function snapshot(assembly: PromptAssembly, callables: ToolSchema[], mode: ToolMode, render: (assembly: PromptAssembly) => string): NamedSectionsSnapshot {
  const sectionLayout = uniqueNames(assembly.sections)
  const sections = assembly.sections.filter(s => !LIVE_SECTION_NAMES.has(s.name)).map(s => ({ name: s.name, text: render({ ...assembly, sections: [s] }), interpolate: false }))
  const body = clone({ coverage: 'named-sections-v1' as const, mode, tools: assembly.tools, callables, sections, sectionLayout })
  return { ...body, revision: revision(body) }
}
// Diagnostic observation is deliberately outside the frozen snapshot revision/CAS.
export function observe(assembly: PromptAssembly, render: (assembly: PromptAssembly) => string, renderContexts: (assembly: PromptAssembly) => { text: string }[]): Observation {
  uniqueNames(assembly.sections); uniqueNames(assembly.contexts ?? [])
  const body = clone({
    sections: assembly.sections.map(s => ({ name: s.name, text: render({ ...assembly, sections: [s] }), live: LIVE_SECTION_NAMES.has(s.name) })),
    tools: assembly.tools,
    contexts: (assembly.contexts ?? []).map(c => ({ name: c.name, text: renderContexts({ ...assembly, contexts: [c] }).map(s => s.text).join('') })),
    // Code-unit order: locale collation would make the observation revision host-dependent.
    variables: Object.entries(assembly.variables ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => ({ name, defined: value !== undefined, ...(value !== undefined ? { value } : {}) })),
  })
  return { ...body, revision: revision(body) }
}
export function observationDiff(before: Observation | null | undefined, after: Observation | null | undefined): ObservationDiff | null {
  if (!before || !after) return null
  return Object.fromEntries((['sections', 'tools', 'contexts', 'variables'] as const).map(unit => {
    const old = new Map<string, ObservationRow>((before[unit] as ObservationRow[]).map(v => [v.name, v])), now = new Map<string, ObservationRow>((after[unit] as ObservationRow[]).map(v => [v.name, v]))
    const beforeOrder = [...old.keys()], afterOrder = [...now.keys()]
    return [unit, {
      added: [...now.values()].filter(v => !old.has(v.name)), removed: [...old.values()].filter(v => !now.has(v.name)),
      changed: [...now.values()].filter(v => old.has(v.name) && JSON.stringify(old.get(v.name)) !== JSON.stringify(v)).map(v => ({ name: v.name, before: old.get(v.name), after: v })),
      beforeOrder, afterOrder, orderChanged: JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder),
    }]
  })) as ObservationDiff
}
// Runtime contexts and variables are observed for diagnostics but never frozen or
// projected: the real assembly always receives their live values. Named sections that
// carry live:true are the same kind of exemption.
export const DIAGNOSTIC_UNITS: readonly ObservationUnit[] = ['contexts', 'variables']
export const isLiveObservationRow = (unit: string, row: ObservationRow) => DIAGNOSTIC_UNITS.some(value => value === unit) || row?.live === true || row?.before?.live === true || row?.after?.live === true
// Adopt the live-tagged diagnostics into the saved baseline so their diff closes without
// touching the frozen snapshot, generation, notices, registration or recovery state. Frozen
// section entries keep their saved text and position, so their differences stay visible
// until the user actually applies a new snapshot.
export function rebaselineObservation(baseline: Observation | null | undefined, current: Observation | null | undefined): Observation | null {
  if (!baseline || !current) return null
  const { revision: ignored, ...body } = clone(baseline)
  if (!Array.isArray(baseline.contexts) || !Array.isArray(current.contexts) || !Array.isArray(baseline.variables) || !Array.isArray(current.variables)) return null
  body.contexts = clone(current.contexts)
  body.variables = clone(current.variables)
  if (!Array.isArray(baseline.sections) || !Array.isArray(current.sections)) return null
  const saved = new Map(baseline.sections.map(section => [section.name, section]))
  const sections = []
  for (const section of current.sections) {
    if (section.live === true) sections.push(clone(section))
    // A frozen section that is new since the baseline keeps its diff until Apply.
    else { const previous = saved.get(section.name); if (previous) sections.push(clone(previous)) }
  }
  // A frozen section removed from the live assembly also keeps its diff until Apply.
  const live = new Set(current.sections.map(section => section.name))
  for (const section of baseline.sections) if (section.live !== true && !live.has(section.name)) sections.push(clone(section))
  body.sections = sections
  return { ...body, revision: revision(body) }
}
export function project(assembly: PromptAssembly, active: FrozenSnapshot): PromptAssembly {
  uniqueNames(assembly.sections)
  if (!expandedCoverage(active)) {
    // Legacy coverage stays effective until explicit review/apply; never adopt new sections here.
    const remaining = new Map(active.sections.map(s => [s.name, s]))
    const sections = assembly.sections.flatMap(s => {
      if (!SDK_NAMES.has(s.name)) return [s]
      const saved = remaining.get(s.name); remaining.delete(s.name)
      return saved ? [clone(saved)] : []
    })
    sections.push(...clone([...remaining.values()]))
    return { ...assembly, tools: clone(active.tools), sections }
  }
  const saved = new Map(active.sections.map(s => [s.name, clone(s)]))
  const live = new Map(assembly.sections.filter(s => LIVE_SECTION_NAMES.has(s.name)).map(s => [s.name, s]))
  // Saved layout is authoritative, including anchors which are temporarily absent.
  const names = [...active.sectionLayout]
  // New live anchors use their nearest following saved anchor, never reorder saved content.
  const currentNames = assembly.sections.map(s => s?.name)
  for (const name of live.keys()) {
    if (names.includes(name)) continue
    const following = currentNames.slice(currentNames.indexOf(name) + 1).find(n => names.includes(n))
    names.splice(following === undefined ? names.length : names.indexOf(following), 0, name)
  }
  const sections = names.flatMap(name => { const section = saved.get(name) ?? live.get(name); return section ? [section] : [] })
  return { ...assembly, tools: clone(active.tools), sections }
}
export function diff(before: FrozenSnapshot | null | undefined, after: FrozenSnapshot | null | undefined) {
  const old = new Map((before?.callables ?? []).map(t => [t.name, t]))
  const now = new Map((after?.callables ?? []).map(t => [t.name, t]))
  const changed = []
  for (const [name, tool] of now) {
    const prev = old.get(name)
    if (!prev) continue
    const fields = (['description', 'parameters', 'deferLoading'] as const).filter(key => JSON.stringify(prev[key]) !== JSON.stringify(tool[key]))
    if (fields.length) changed.push({ name, fields, before: prev, after: tool })
  }
  const oldSections = new Map((before?.sections ?? []).map(s => [s.name, s]))
  const newSections = new Map((after?.sections ?? []).map(s => [s.name, s]))
  const sectionDiff: { added: FrozenSnapshot['sections']; removed: FrozenSnapshot['sections']; changed: { name: string; before: string; after: string }[]; beforeOrder: string[]; afterOrder: string[]; orderChanged?: boolean } = {
    added: [...newSections.values()].filter(s => !oldSections.has(s.name)),
    removed: [...oldSections.values()].filter(s => !newSections.has(s.name)),
    changed: [...newSections.values()].filter(s => oldSections.has(s.name) && oldSections.get(s.name)?.text !== s.text).map(s => ({ name: s.name, before: oldSections.get(s.name)?.text ?? '', after: s.text })),
    beforeOrder: before?.sectionLayout ?? (before?.sections ?? []).map(s => s.name),
    afterOrder: after?.sectionLayout ?? (after?.sections ?? []).map(s => s.name),
  }
  sectionDiff.orderChanged = JSON.stringify(sectionDiff.beforeOrder) !== JSON.stringify(sectionDiff.afterOrder)
  return { sections: sectionDiff, coverageChanged: !expandedCoverage(before) && expandedCoverage(after), added: [...now.keys()].filter(n => !old.has(n)), removed: [...old.keys()].filter(n => !now.has(n)), changed,
    orderChanged: JSON.stringify(before?.tools.map(t => t.name) ?? []) !== JSON.stringify(after?.tools.map(t => t.name) ?? []),
    wireChanged: JSON.stringify(before?.tools ?? []) !== JSON.stringify(after?.tools ?? []),
    sdkChanged: JSON.stringify((before?.sections ?? []).filter(s => SDK_NAMES.has(s.name))) !== JSON.stringify((after?.sections ?? []).filter(s => SDK_NAMES.has(s.name))),
    modeChanged: before?.mode !== after?.mode }
}
function assertRecord(value: unknown, id: SessionId, profileIdentity?: string): asserts value is SnapshotRecord {
  if (!isObject(value)) throw new Error('Invalid snapshot record; explicit baseline required')
  const record = value
  if (record.format !== 2 || typeof record.profileIdentity !== 'string' || (profileIdentity !== undefined && record.profileIdentity !== profileIdentity) || record.sessionId !== id || typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 1) throw new Error('Invalid snapshot record; explicit baseline required')
  validateCheckpoint(record.checkpoint)
  const object = isObject
  const validTool = (t: unknown) => object(t) && typeof t.name === 'string' && t.name.length > 0 && typeof t.description === 'string' && object(t.parameters) && (!Object.hasOwn(t, 'deferLoading') || t.deferLoading === true)
  const checkSnapshot = (snap: unknown) => {
    if (!object(snap)) throw new Error('Missing/invalid active snapshot; explicit baseline required')
    const { revision: rev, ...body } = snap
    if (body.coverage !== undefined && snap.coverage !== 'named-sections-v1') throw new Error('Unknown snapshot coverage')
    if (snap.coverage === 'named-sections-v1') {
      if (!Array.isArray(body.sectionLayout) || body.sectionLayout.some((n: unknown) => typeof n !== 'string' || !n.length) || new Set(body.sectionLayout).size !== body.sectionLayout.length || !Array.isArray(body.sections) || JSON.stringify(body.sectionLayout.filter((n: unknown) => typeof n === 'string' && !LIVE_SECTION_NAMES.has(n))) !== JSON.stringify(body.sections.map((s: unknown) => object(s) ? s.name : undefined))) throw new Error('Snapshot layout integrity failure')
    }
    if (Array.isArray(body.sections)) uniqueNames(body.sections)
    if (!Array.isArray(body.tools) || !body.tools.every(validTool) || !Array.isArray(body.callables) || !body.callables.every(validTool) || !Array.isArray(body.sections) || !body.sections.every((s: unknown) => object(s) && typeof s.name === 'string' && (snap.coverage === 'named-sections-v1' ? !LIVE_SECTION_NAMES.has(s.name) && s.name.length > 0 : SDK_NAMES.has(s.name)) && typeof s.text === 'string' && s.interpolate === false) || !['native', 'ptc', 'both'].some(mode => mode === body.mode) || revision(body) !== rev) throw new Error('Snapshot integrity failure; explicit baseline required')
  }
  if (record.observation != null) {
    if (!object(record.observation)) throw new Error('Observation integrity failure')
    const { revision: rev, ...body } = record.observation
    if (revision(body) !== rev) throw new Error('Observation integrity failure')
    for (const key of ['sections', 'tools', 'contexts', 'variables'] as const) {
      const rows = body[key]
      if (!Array.isArray(rows) || !rows.every((v: unknown) => object(v) && typeof v.name === 'string')) throw new Error('Observation integrity failure')
      uniqueNames(rows)
      if (!rows.every((v: unknown) => {
        if (!object(v)) return false
        if (key === 'sections') return typeof v.text === 'string' && typeof v.live === 'boolean'
        if (key === 'tools') return validTool(v)
        if (key === 'contexts') return typeof v.text === 'string'
        return typeof v.defined === 'boolean' && (v.defined ? typeof v.value === 'string' : !Object.hasOwn(v, 'value'))
      })) throw new Error('Observation integrity failure')
    }
  }
  checkSnapshot(record.active)
  validateRegistration(record)
  if (record.notice !== null) {
    const notice = record.notice
    if (!object(notice) || !Object.hasOwn(notice, 'from')) throw new Error('Invalid notice record; explicit baseline required')
    const message = notice.message
    if (!object(message) || typeof message.id !== 'string' || !message.id.length || message.role !== 'user' || !object(message.source) || !isSourceKind(message.source.kind) || message.source.form !== 'notice' || typeof message.source.summary !== 'string' || !Array.isArray(message.content) || !message.content.length || !message.content.every((b: unknown) => object(b) && b.type === 'text' && typeof b.text === 'string')) throw new Error('Invalid notice record; explicit baseline required')
    if (notice.from !== null) checkSnapshot(notice.from)
  }
  if (record.kept !== null && typeof record.kept !== 'string') throw new Error('Invalid kept revision; explicit baseline required')
}
export function validateRecord(value: unknown, id: SessionId, profileIdentity?: string): SnapshotRecord {
  assertRecord(value, id, profileIdentity)
  return value
}
/** Per-process serialization; one DSH process must own a state directory. */
export class Store {
  declare profileIdentity: string
  declare base: string
  declare directory: string
  declare queues: Map<SessionId, Promise<unknown>>
  declare identifiableFile: typeof identifiableFile
  #references: Map<SessionId, PayloadReference>
  #owned = new WeakSet()
  constructor(directory?: string, profileDir?: string) {
    if (!directory && !profileDir) throw new Error('Outside a Profile, an explicit snapshot directory is required')
    this.profileIdentity = revision(profileDir ? { profile: resolve(profileDir) } : { standalone: resolve(directory as string) })
    this.base = resolve(directory || join(profileDir as string, STORAGE_DIRECTORY))
    this.directory = join(this.base, this.profileIdentity)
    this.queues = new Map()
    this.#references = new Map()
    // Injectable so tests can exercise volumes that report no usable inode identity.
    this.identifiableFile = identifiableFile
  }
  path(id: SessionId) {
    const target = resolve(this.directory, `${revision(id)}.json`)
    if (dirname(target) !== this.directory) throw new Error('Snapshot path escaped owned directory')
    return target
  }
  // Only components this plugin owns are validated: the storage root and the
  // profile-identity directory inside it. Everything above the root is environment
  // input (the DSH Profile directory or an explicit user directory), so a symlinked
  // ancestor such as macOS /tmp -> private/tmp must not make the plugin unusable.
  async #ownedDirectory() {
    for (const path of [this.base, this.directory]) {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe snapshot directory')
    }
    // Resolve both sides: Windows drive-letter case and path normalization must not look
    // like an escape, and a redirected identity directory is still rejected.
    if (await realpath(this.directory) !== join(await realpath(this.base), this.profileIdentity)) throw new Error('Snapshot directory escaped scope')
  }
  async safeDirectory(create = false) {
    if (create) {
      // Refuse a symlinked storage root before creating anything beneath it.
      try { if ((await lstat(this.base)).isSymbolicLink()) throw new Error('Unsafe snapshot directory') }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
    }
    await this.#ownedDirectory()
  }
  forget(id: SessionId) { this.#references.delete(id) }
  payloadPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid payload reference')
    return join(this.directory, `payload-${hash}.json`)
  }
  async load(id: SessionId): Promise<LoadedRecord | null> {
    this.#references.delete(id)
    try { await this.safeDirectory() } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
    let data: Record<string, unknown>
    try { data = parseObject((await readRegular(this.path(id))).text) }
    catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
    if (data?.format === 1 && data.sessionId === id) return { legacy: true } as LoadedRecord
    if (data?.format !== 3) return validateRecord(data, id, this.profileIdentity)
    if (data.profileIdentity !== this.profileIdentity || data.sessionId !== id || Object.keys(data).sort().join() !== 'checkpoint,format,payload,profileIdentity,sessionId') throw new Error('Invalid snapshot manifest')
    validateCheckpoint(data.checkpoint)
    // Missing payload is corruption, never absence of a session manifest.
    const { text, stat } = await readRegular(this.payloadPath(typeof data.payload === "string" ? data.payload : ""))
    if (payloadHash(text) !== data.payload) throw new Error('Payload integrity failure')
    const payload = parseObject(text)
    if (Object.hasOwn(payload, 'checkpoint')) throw new Error('Invalid snapshot payload')
    const record = freezeRecord(validateRecord({ ...payload, checkpoint: data.checkpoint }, id, this.profileIdentity))
    this.#owned.add(record)
    this.#references.set(id, { record, hash: data.payload as string, stat })
    return record
  }
  async syncDirectory() { return fsyncDirectory(this.directory) }
  async delete(id: SessionId) {
    // Blobs are retained intentionally: no cross-session deletion or orphan GC.
    this.#references.delete(id)
    await this.safeDirectory()
    const target = this.path(id)
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Unsafe snapshot file')
    await unlink(target)
    await this.syncDirectory()
  }
  async writeManifest(record: SnapshotRecord, hash: string) {
    const target = this.path(record.sessionId)
    try { await regularStat(target) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
    const manifest = { format: 3, profileIdentity: this.profileIdentity, sessionId: record.sessionId, checkpoint: record.checkpoint, payload: hash }
    const temporary = `${target}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(manifest)); await file.sync() } finally { await file.close() }
    await renameWithRetry(temporary, target)
    await this.syncDirectory()
  }
  async save(record: SnapshotRecord): Promise<SnapshotRecord> {
    const id = record.sessionId
    this.#references.delete(id)
    try {
      // Own a detached immutable snapshot, never bind mutable caller input.
      const owned = clone(record)
      validateRecord(owned, id, this.profileIdentity)
      owned.checkpoint = validateCheckpoint(owned.checkpoint)
      const { checkpoint: ignored, ...payload } = owned
      const text = JSON.stringify(payload), hash = payloadHash(text)
      await this.safeDirectory(true)
      await writePayload(this.payloadPath(hash), text, hash, () => this.syncDirectory())
      const stat = await regularStat(this.payloadPath(hash))
      await this.writeManifest(owned, hash)
      freezeRecord(owned)
      this.#owned.add(owned)
      this.#references.set(id, { record: owned, hash, stat })
      return owned
    } catch (error) { this.#references.delete(id); throw error }
  }
  async saveCheckpoint(record: SnapshotRecord, checkpoint: Checkpoint): Promise<SnapshotRecord> {
    const id = record.sessionId, reference = this.#references.get(id)
    const cp = validateCheckpoint(checkpoint)
    // Reject stale owners without poisoning the newer valid reference.
    if (!reference || reference.record !== record) {
      if (this.#owned.has(record)) throw new Error('Stale Store-owned record; reload before checkpoint')
      return await this.save({ ...record, checkpoint: cp })
    }
    try {
      await this.safeDirectory()
      if (reference.uncertain) {
        // A prior write may have switched the checkpoint manifest. Re-establish
        // durability only if disk still names this exact logical payload.
        const manifest = parseObject((await readRegular(this.path(id))).text)
        if (manifest.format !== 3 || manifest.sessionId !== id || manifest.profileIdentity !== this.profileIdentity || manifest.payload !== reference.hash || Object.keys(manifest).sort().join() !== 'checkpoint,format,payload,profileIdentity,sessionId') throw new Error('Checkpoint recovery payload mismatch; reload required')
        validateCheckpoint(manifest.checkpoint)
        reference.stat = await verifyReferencePayload(this.payloadPath(reference.hash), reference.hash, () => this.syncDirectory())
      } else {
        const stat = await regularStat(this.payloadPath(reference.hash))
        // A cheap inode identity check only proves anything where the volume reports real
        // inode numbers; elsewhere re-verify the bytes rather than trust a coincidence.
        if (!this.identifiableFile(reference.stat) || !this.identifiableFile(stat)) reference.stat = await verifyReferencePayload(this.payloadPath(reference.hash), reference.hash, () => this.syncDirectory())
        else if (!sameFile(reference.stat, stat)) throw new Error('Payload changed since validation')
      }
      const owned = Object.freeze({ ...record, checkpoint: freezeRecord(cp) })
      await this.writeManifest(owned, reference.hash)
      this.#owned.add(owned)
      this.#references.set(id, { ...reference, record: owned, uncertain: false })
      return owned
    } catch (error) {
      // Retain identity only, never reuse an unverified stat shortcut on retry.
      if (this.#references.get(id) === reference) reference.uncertain = true
      throw error
    }
  }
  serial<T>(id: SessionId, job: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(job)
    this.queues.set(id, current)
    return current.finally(() => { if (this.queues.get(id) === current) this.queues.delete(id) })
  }
}
