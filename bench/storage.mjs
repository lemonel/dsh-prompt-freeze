import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Store, snapshot, observe } from '../lib/core.mjs'
import { payloadHash } from '../lib/storage.mjs'
import assert from 'node:assert/strict'

const rounds = 20
const cp = n => ({ count: n, inheritedEventCount: 0, hash: String(n % 10).repeat(64), time: 1700000000000 + n })
const metrics = samples => { const s = [...samples].sort((a, b) => a - b); return { p50Ms: s[Math.floor(s.length * .5)], p95Ms: s[Math.min(s.length - 1, Math.floor(s.length * .95))] } }
const results = []
for (const count of [30, 100, 300]) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'prompt-freeze-storage-bench-')))
  const tools = Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i} documentation. `.repeat(100), parameters: { type: 'object', properties: { input: { type: 'string', description: 'Detailed input contract. '.repeat(30) } } } }))
  const assembly = { tools, sections: [{ name: 'custom', text: 'Frozen system instructions. '.repeat(1000) }], contexts: [], variables: {} }
  const render = a => a.sections.map(s => s.text).join('\n')
  const input = { format: 2, profileIdentity: store.profileIdentity, sessionId: 'storage-bench', generation: 1, active: snapshot(assembly, tools, 'native', render), observation: observe(assembly, render, () => []), notice: null, kept: null, checkpoint: cp(10), registrationOutbox: [] }
  const started = performance.now()
  let owned = await store.save(input)
  const initialSaveMs = performance.now() - started
  const manifestPath = store.path(input.sessionId), manifest = JSON.parse(await readFile(manifestPath, 'utf8')), path = store.payloadPath(manifest.payload)
  const before = await stat(path), beforeHash = payloadHash(await readFile(path, 'utf8'))
  const checkpointTimes = [], fullSaveTimes = [], manifestBytes = new Set()
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    owned = await store.saveCheckpoint(owned, cp(11 + i))
    checkpointTimes.push(performance.now() - start)
    manifestBytes.add((await stat(manifestPath)).size)
  }
  const after = await stat(path), afterHash = payloadHash(await readFile(path, 'utf8'))
  assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(beforeHash, afterHash); assert.equal(manifestBytes.size, 1)
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    owned = await store.save({ ...owned, checkpoint: cp(31 + i) })
    fullSaveTimes.push(performance.now() - start)
  }
  results.push({ tools: count, rounds, initialSaveMs, manifestBytes: [...manifestBytes][0], payloadBytes: before.size, logicalRecordBytes: Buffer.byteLength(JSON.stringify(input)), payloadHashUnchanged: beforeHash === afterHash, payloadMtimeUnchanged: before.mtimeMs === after.mtimeMs, checkpointOnly: metrics(checkpointTimes), fullSaveFormat3: metrics(fullSaveTimes) })
}
console.log(JSON.stringify({ note: 'Isolated temp-directory fixtures. Full-save baseline is format3 Store.save, NOT the former monolithic format2 writer. Immutable payloads intentionally retained; no orphan GC.', results }, null, 2))
