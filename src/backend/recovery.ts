import type { Checkpoint, Context, SessionId } from './types.js'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { clone, revision } from './core.js'

export const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
export function checkpoint(cut: SessionLogSnapshot, time = Date.now()): Checkpoint {
  return { count: cut.events.length, inheritedEventCount: cut.inheritedEventCount, hash: revision(canonical({ header: { ...cut.session, delegationDepth: cut.session.delegationDepth ?? 0 }, inheritedEventCount: cut.inheritedEventCount, events: cut.events })), time }
}
export function startupMarker(event: SessionLogSnapshot['events'][number]) {
  return event.type === 'session/end-seed' && Number.isSafeInteger(event.seq) && validTime(event.time) && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && Object.keys(event.data).length === 0 && Object.keys(event).every(key => ['type', 'seq', 'time', 'data'].includes(key))
}
export function matches(cut: SessionLogSnapshot, saved: Checkpoint | null, allowMarkers = true) {
  if (!saved || !cut.events.every((event, index) => event.seq === index) || cut.inheritedEventCount !== saved.inheritedEventCount || cut.events.length < saved.count) return false
  const prefix = { ...cut, events: cut.events.slice(0, saved.count) }
  return checkpoint(prefix).hash === saved.hash && (!allowMarkers || cut.events.slice(saved.count).every(startupMarker))
}
export function lastActivity(cut: SessionLogSnapshot, now = Date.now()) {
  if (!cut || !Number.isSafeInteger(cut.inheritedEventCount)) return null
  const own = cut.events.filter(event => event.seq >= cut.inheritedEventCount && (event.type === 'user/message' && event.data?.source?.kind === 'user' || ['assistant/message', 'tool/call', 'tool/result'].includes(event.type)))
  const times = own.length ? own.map(event => event.time) : [cut.session?.createdAt]
  if (times.some(time => !validTime(time) || time > now)) return null
  return Math.max(...times)
}
export async function durableCut(ctx: Context, id: SessionId): Promise<SessionLogSnapshot | null> {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return null
  const handle = await persistence.open(id, 'read')
  try { const { events } = await handle.read(); return clone({ session: handle.header, inheritedEventCount: handle.inheritedEventCount, events }) as SessionLogSnapshot }
  finally { await handle.close() }
}
