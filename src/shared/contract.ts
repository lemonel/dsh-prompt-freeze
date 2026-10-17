interface SnapshotStatus { sessionId: string; generation: number; busy: boolean; baselineRequired: boolean; noticeState: string; [key: string]: unknown }
interface WireCodec<T> { mode: 'strict'; typeSymbol: string; create(): { parse(value: unknown): T } }
export const PACKAGE = '@lemonel/dsh-prompt-freeze'
const codec = <T,>(name: string, parse: (value: unknown) => T): WireCodec<T> => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse }) })
const text = codec('string', v => { if (typeof v !== 'string' || !v.length) throw new Error('Expected nonempty string'); return v })
const integer = codec('generation', v => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Expected nonnegative generation'); return v })
const setting = codec('autoApplySetting', v => { if (v !== null && typeof v !== 'string') throw new Error('Expected string or null'); return v })
const recoveryChoice = codec('recoveryChoice', v => { if (v !== 'keep' && v !== 'recapture') throw new Error('Expected keep or recapture'); return v })
const boolean = codec('boolean', v => { if (typeof v !== 'boolean') throw new Error('Expected boolean'); return v })
const result = codec('status', (value: unknown): SnapshotStatus => {
  const v = value as Partial<SnapshotStatus> | null | undefined
  if (!v || typeof v.sessionId !== 'string' || !Number.isSafeInteger(v.generation) || typeof v.busy !== 'boolean' || typeof v.baselineRequired !== 'boolean' || typeof v.noticeState !== 'string') throw new Error('Invalid snapshot status')
  return v as SnapshotStatus
})
const method = (name: string, parameters: [string, WireCodec<unknown>][]) => ({ id: `${PACKAGE}#promptFreeze/${name}`, service: 'promptFreeze', namespace: 'promptFreeze', method: name, invocation: { kind: 'direct' }, parameters: parameters.map(([name, codec]) => ({ name, wire: name, source: 'json', codec })), result })
export const descriptors = [method('status', [['id', text]]), method('applySnapshot', [['id', text], ['expectedRevision', text], ['expectedGeneration', integer], ['baseline', boolean]]), method('keep', [['id', text], ['expectedRevision', text], ['expectedGeneration', integer]]), method('summary', [['id', text]]), method('setAutoApply', [['id', text], ['value', setting], ['expectedSettingsRevision', integer]]), method('resolveRecovery', [['id', text], ['requestId', text], ['choice', recoveryChoice]]), method('acknowledgeObservation', [['id', text], ['expectedObservationRevision', text]])]
export const remote = { package: PACKAGE, descriptors }
