import type { CSSProperties } from 'react'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { Unit, DiffRow, ContentValue, PanelState, AutoApplyView, RecoveryOutcome, SettingsState, PanelProps, RemoteMethod, QueuedRequest, DisplayError, ChildRecovery } from './client-types.js'
import { categories, changeKinds, tokenCount, formatTokens, categoryDelta } from './display.js'
import { standaloneTranslator } from './locales.js'

const seenRecoveryOutcomes = new Map<string, Set<string>>()
const seenRecoveryPrompts = new Map<string, Set<string>>()

export function usePromptFreezePanel({ sessionId, promptFreezeRemote, t = standaloneTranslator() }: PanelProps) {
  const [state, setState] = useState<PanelState | null>(null), [error, setError] = useState<DisplayError>(''), [open, setOpen] = useState(false), [working, setWorking] = useState(false)
  const [review, setReview] = useState<PanelState | null>(null), [selected, setSelected] = useState<Unit>('tools')
  const [preview, setPreview] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsState>({ draft: '', baseRevision: null, dirty: false, conflict: false, pending: false, error: '', result: false })
  const settingsRef = useRef(settings)
  const updateSettings = (patch: Partial<SettingsState>): void => { settingsRef.current = { ...settingsRef.current, ...patch }; setSettings(settingsRef.current) }
  const adoptSettings = (auto: AutoApplyView | undefined): void => {
    if (!auto || !Number.isSafeInteger(auto.settingsRevision)) return
    const draft = auto.override ?? (tokenCount(auto.thresholdTokens) ? `${auto.thresholdTokens / 1000}K` : '')
    updateSettings({ draft, savedDraft: draft, baseRevision: auto.settingsRevision, dirty: false, conflict: false })
  }
  const [recoveryUI, setRecoveryUI] = useState<{ open: boolean; pending: boolean; error: DisplayError }>({ open: false, pending: false, error: '' })
  const recoveryRef = useRef<{ id: string | null; opened: string | null; pending: boolean }>({ id: null, opened: null, pending: false })
  const [toast, setToast] = useState<RecoveryOutcome | null>(null), [toastPosition, setToastPosition] = useState<CSSProperties>({ left: 8, top: 8 })
  const toastNode = useRef<HTMLDivElement | null>(null), toastClock = useRef<{ timer: ReturnType<typeof setTimeout> | null; remaining: number; started: number }>({ timer: null, remaining: 5000, started: 0 })
  const positionToast = () => {
    if (typeof window === 'undefined') return
    const rect = trigger.current?.getBoundingClientRect(), node = toastNode.current
    if (!rect || !node) return
    const width = node.offsetWidth, height = node.offsetHeight
    setToastPosition({ left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)), top: Math.max(8, rect.top - height - 8), maxHeight: Math.max(24, rect.top - 16) })
  }
  const pauseToast = () => {
    const clock = toastClock.current
    if (clock.timer !== null) { clearTimeout(clock.timer); clock.timer = null; clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.started)) }
  }
  const resumeToast = () => {
    const clock = toastClock.current
    if (clock.timer !== null) return
    clock.started = Date.now()
    clock.timer = setTimeout(() => { clock.timer = null; setToast(null) }, clock.remaining)
  }
  const receiveRecovery = (value: PanelState): void => {
    const recovery = value?.recovery, current = recoveryRef.current
    if (current.id !== (recovery?.id ?? null)) {
      current.id = recovery?.id ?? null; current.opened = null
      setRecoveryUI(ui => ({ ...ui, error: '', open: false }))
    }
    // A dismissed idle prompt must reopen when a real request starts waiting, even
    // though the backend preserves its ID so an in-flight answer stays valid.
    const promptKey = recovery ? JSON.stringify([recovery.id, recovery.phase]) : null
    if (recovery && ['awaiting-choice', 'pending'].includes(recovery.phase) && promptKey && current.opened !== promptKey) {
      current.opened = promptKey
      let seen = seenRecoveryPrompts.get(sessionId)
      if (!seen) {
        seen = new Set(); seenRecoveryPrompts.set(sessionId, seen)
        if (seenRecoveryPrompts.size > 100) seenRecoveryPrompts.delete(seenRecoveryPrompts.keys().next().value!)
      }
      if (!seen.has(promptKey)) {
        seen.add(promptKey)
        if (seen.size > 20) seen.delete(seen.values().next().value!)
        setRecoveryUI(ui => ({ ...ui, open: true }))
      }
    } else if (!recovery || !['awaiting-choice', 'pending'].includes(recovery.phase)) setRecoveryUI(ui => ({ ...ui, open: false }))
    const outcome = value?.recoveryOutcome
    if (!outcome || !['kept-unchanged', 'kept-changed', 'recaptured', 'auto-kept-unchanged', 'auto-kept-changed'].includes(outcome.kind)) return
    if (outcome.usageStatus === 'pending') return
    let seen = seenRecoveryOutcomes.get(sessionId)
    if (!seen) {
      seen = new Set(); seenRecoveryOutcomes.set(sessionId, seen)
      if (seenRecoveryOutcomes.size > 100) seenRecoveryOutcomes.delete(seenRecoveryOutcomes.keys().next().value!)
    }
    if (seen.has(outcome.id!)) return
    seen.add(outcome.id!)
    if (seen.size > 20) seen.delete(seen.values().next().value!)
    if (recovery?.error || value?.error) return
    pauseToast(); toastClock.current.remaining = 5000
    setToast(outcome); resumeToast()
  }
  const receiveState = (value: PanelState): void => {
    receiveRecovery(value)
    const auto = value?.autoApply, current = settingsRef.current
    if (!current.dirty && !current.pending) adoptSettings(auto)
    else if (auto && Number.isSafeInteger(auto.settingsRevision) && auto.settingsRevision !== current.baseRevision) updateSettings({ conflict: true })
    setState(value)
  }
  const trigger = useRef<HTMLButtonElement | null>(null), reviewEpoch = useRef(0)
  const close = () => { ++reviewEpoch.current; updateSettings({ pending: false }); setPreview(null); setReview(null); setOpen(false); trigger.current?.focus() }
  const focusClose = useCallback((node: HTMLButtonElement | null) => node?.focus(), [])
  const panelId = `pf-detail-${encodeURIComponent(sessionId)}`
  const serial = useRef(0), alive = useRef(true), inFlight = useRef(false), queue = useRef<QueuedRequest[]>([]), pendingReview = useRef<number | null>(null)
  function call(method: RemoteMethod, args: unknown[] = [], onSuccess?: (value: PanelState) => void, epoch: number | null = null): Promise<void> {
    // Polls skip a busy slot; user review intent survives a pending poll.
    if (!alive.current || (method !== 'status' && method !== 'resolveRecovery' && method !== 'setAutoApply' && inFlight.current)) return Promise.resolve()
    if (method === 'status' && pendingReview.current === epoch) return Promise.resolve()
    if (method === 'status') pendingReview.current = epoch
    const token = serial.current
    const valid = () => alive.current && token === serial.current && (epoch === null || epoch === reviewEpoch.current)
    setWorking(true)
    return new Promise<void>(resolve => {
      queue.current.push({ receive: receiveState, method, invoke: () => promptFreezeRemote[method](sessionId, ...args), onSuccess, epoch, valid, resolve })
      void drain()
    })
  }
  async function drain(): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    while (queue.current.length) {
      const { receive, method, invoke, onSuccess, epoch, valid, resolve } = queue.current.shift()!
      try {
        if (!valid()) continue
        setError('')
        const response = await invoke()
        if (!response.ok) throw response.error?.message ? new Error(response.error.message) : { localeKey: 'requestFailed' }
        if (valid()) { onSuccess?.(response.value); receive(response.value) }
      } catch (e) {
        if (valid()) {
          const message: DisplayError = typeof e === 'object' && e !== null
            ? 'localeKey' in e && typeof e.localeKey === 'string' && e.localeKey
              ? { localeKey: e.localeKey }
              : 'message' in e && typeof e.message === 'string' ? e.message : ''
            : typeof e === 'string' ? e : ''
          if (method === 'resolveRecovery') setRecoveryUI(ui => ({ ...ui, error: message }))
          else if (method === 'setAutoApply') updateSettings({ pending: false, error: message, result: false })
          else setError(message)
        }
      }
      finally {
        if (method === 'resolveRecovery' && valid()) { recoveryRef.current.pending = false; setRecoveryUI(ui => ({ ...ui, pending: false })) }
        if (method === 'status' && pendingReview.current === epoch) pendingReview.current = null
        resolve()
      }
    }
    inFlight.current = false
    if (alive.current) setWorking(false)
  }
  useEffect(() => {
    alive.current = true
    setState(null); setReview(null); setPreview(null); setError('')
    recoveryRef.current = { id: null, opened: null, pending: false }
    setRecoveryUI({ open: false, pending: false, error: '' }); setToast(null)
    updateSettings({ draft: '', baseRevision: null, dirty: false, conflict: false, pending: false, error: '', result: false })
    let timer: ReturnType<typeof setTimeout>, stopped = false
    const refresh = async () => { await call('summary'); if (!stopped) timer = setTimeout(refresh, recoveryRef.current.id ? 1000 : 4000) }
    void refresh()
    return () => { stopped = true; alive.current = false; ++serial.current; ++reviewEpoch.current; pendingReview.current = null; clearTimeout(timer); pauseToast() }
  }, [sessionId, promptFreezeRemote])
  useEffect(() => {
    if (!toast || typeof window === 'undefined') return () => {}
    positionToast()
    const dismissOutside = (event: PointerEvent) => {
      if (toastNode.current?.contains(event.target as Node)) return
      pauseToast(); setToast(null)
    }
    window.addEventListener?.('pointerdown', dismissOutside, true)
    window.addEventListener?.('resize', positionToast)
    window.addEventListener?.('scroll', positionToast, true)
    return () => { window.removeEventListener?.('pointerdown', dismissOutside, true); window.removeEventListener?.('resize', positionToast); window.removeEventListener?.('scroll', positionToast, true) }
  }, [toast])
  const recovery = state?.recovery
  const recoveryBlocked = !!recovery || recoveryUI.pending
  const recoveryError = recoveryUI.error?.localeKey ? t(recoveryUI.error.localeKey) : (recoveryUI.error as string) || recovery?.error
  const copyDeferred = (text: string): void => { try { void globalThis.navigator?.clipboard?.writeText?.(text) } catch { /* the clipboard is optional */ } setToast({ kind: 'deferred-copied' }) }
  const dismissRecovery = () => { setRecoveryUI(ui => ({ ...ui, open: false })); trigger.current?.focus() }
  const answerRecovery = (choice: 'keep' | 'recapture'): Promise<void> => {
    if (!recovery || !['pending', 'awaiting-choice'].includes(recovery.phase) || recoveryRef.current.pending) return Promise.resolve()
    recoveryRef.current.pending = true
    setRecoveryUI(ui => ({ ...ui, pending: true, error: '' }))
    return call('resolveRecovery', [recovery.id, choice])
  }
  const shown = review
  const stale = !!review && (review.candidate?.revision !== state?.candidate?.revision || review.generation !== state?.generation)
  const changed = !!shown?.active && shown?.candidate?.revision !== shown?.active?.revision
  const liveMismatch = !!state?.active && !!state?.candidate && state.candidate.revision !== state.active.revision
  const autoApply = state?.autoApply
  const saveSettings = (value: string): Promise<void> => {
    // Queue a blur/Enter save behind polling; the synchronous ref prevents duplicates.
    if (!settingsRef.current.dirty || settingsRef.current.pending || settingsRef.current.baseRevision === null || !open) return Promise.resolve()
    if (value === settingsRef.current.savedDraft) {
      updateSettings({ dirty: false, error: '', result: false })
      // No local change: accept any newer setting discovered by polling.
      adoptSettings(state?.autoApply)
      return Promise.resolve()
    }
    updateSettings({ pending: true, error: '', result: false })
    const revision = settingsRef.current.conflict ? state?.autoApply?.settingsRevision : settingsRef.current.baseRevision
    if (!Number.isSafeInteger(revision)) { updateSettings({ pending: false }); return Promise.resolve() }
    return call('setAutoApply', [value, revision], response => {
      const failure = response?.autoApply?.settingsError
      updateSettings({ pending: false, error: failure || '', result: !failure })
      if (!failure) adoptSettings(response?.autoApply)
    }, reviewEpoch.current)
  }
  const settingsError = settings.error?.localeKey ? t(settings.error.localeKey) : settings.error || autoApply?.settingsError
  const autoPending = liveMismatch && autoApply?.eligible === true
  const thresholdText = tokenCount(autoApply?.thresholdTokens) ? t('autoThreshold', { tokens: formatTokens(autoApply.thresholdTokens) }) : t('autoDisabled')
  const autoStatus = autoPending ? t('autoPending') : autoApply?.error ? t('autoError', { error: autoApply.error }) : tokenCount(autoApply?.thresholdTokens) && liveMismatch ? t('autoManual') : ''
  const displayedError = error?.localeKey ? t(error.localeKey) : error || state?.error
  const showAutoInfo = autoPending && !recoveryBlocked && !recoveryError && !displayedError && !state?.recoveryWarning && !state?.checkpointError && !autoApply?.error && !settingsError
  const triggerWarning = [...new Set([
    recoveryBlocked && t('recoveryWaiting'),
    recoveryError && t('error', { error: recoveryError }),
    liveMismatch && (autoPending ? t('autoPending') : t('mismatch')),
    displayedError && t('error', { error: displayedError }),
    autoApply?.error && t('autoError', { error: autoApply.error }),
    settingsError && t('settingsError', { error: settingsError }),
    state?.recoveryWarning && t(recovery ? 'recoveryWaiting' : state?.recoveryOutcome ? 'notificationReset' : 'recoveryShort'),
    state?.checkpointError && t('checkpointShort', { error: state.checkpointError }),
  ].filter(Boolean))].join('；')
  const healthy = !!state?.active?.revision && !!state?.candidate?.revision && state.active.revision === state.candidate.revision && !triggerWarning && !recoveryBlocked && !state.awaitingFirstCall && !state.baselineRequired && !state.upgradeRequired && !state.registrationError && !((state.registrationPending ?? 0) > 0) && !settings.pending && !settings.conflict
  // Compact summary tag: which categories hold live (non-frozen) differences right now.
  const liveChanges = state?.liveChanges
  const liveUnits = liveChanges ? categories.filter(unit => liveChanges[unit]).map(unit => liveChanges[unit]?.count ? `${t(unit)} ${liveChanges[unit]?.count}` : t(unit)).join(' · ') : ''
  const triggerDescription = ['Prompt Freeze', thresholdText, triggerWarning, liveUnits && t('liveSummary', { units: liveUnits }), healthy && t('healthy'), !autoPending && autoStatus].filter(Boolean).join('；')
  // A delegated session's automatic keep is recorded on the parent, which is where the human is looking.
  const childRecoveries = Array.isArray(state?.childRecoveries) ? state.childRecoveries : []
  const childName = (item: ChildRecovery): string => item.label || String(item.sessionId ?? '').slice(0, 8)
  const childRecoveryNote = childRecoveries.length ? [t('childRecoveries', { name: childName(childRecoveries[childRecoveries.length - 1]) }), childRecoveries.length > 1 ? t('childRecoveriesMore', { count: childRecoveries.length - 1 }) : ''].filter(Boolean).join(' ') : ''
  const disabled = recoveryBlocked || working || state?.busy || (!state?.active && !state?.baselineRequired) || !review?.candidate || stale
  const adoptReview = (value: PanelState): void => {
    const pinned = value ? JSON.parse(JSON.stringify(value)) : null
    setPreview(null); setReview(pinned)
  }
  const refreshReview = () => {
    const epoch = reviewEpoch.current
    // Pin this request's response, never the state captured before awaiting status.
    return call('status', [], adoptReview, epoch)
  }
  const short = (value: string | undefined): string => value?.slice(0, 12) ?? t('notEstablished')
  const notification: Record<string, string> = { none: t('noticeNone'), pending: t('noticePending'), 'committed-not-durable': t('noticeCommitted'), 'in-history': t('noticeSaved') }
  const deltas = open && review ? Object.fromEntries(categories.map(unit => [unit, categoryDelta(shown, unit)])) : null
  // Only entries the host marks live are unfrozen diagnostics: runtime contexts, variables,
  // and sections carrying live:true. One footer acknowledgement closes exactly those.
  const liveUnit = (unit: Unit): boolean => unit === 'contexts' || unit === 'variables'
  const liveRow = (unit: Unit, row: DiffRow | string): boolean => liveUnit(unit) || (row as DiffRow)?.live === true || ((row as DiffRow)?.before as ContentValue)?.live === true || ((row as DiffRow)?.after as ContentValue)?.live === true
  const hasLiveChanges = (unit: Unit): boolean => {
    const delta = deltas?.[unit]
    if (!delta?.available) return false
    if (changeKinds.some(kind => delta[kind].some(row => liveRow(unit, row)))) return true
    return liveUnit(unit) && !!delta.orderChanged
  }
  const acknowledgeBaseline = shown?.observation?.baseline?.revision
  const acknowledgeVisible = !!deltas && !!acknowledgeBaseline && categories.some(hasLiveChanges)
  const clearLiveDiffs = (previous: PanelState | null): PanelState | null => {
    const diff = previous?.observation?.diff
    if (!diff) return previous
    const clear = (unit: Unit) => {
      const source = diff[unit] ?? {}
      // Whole units are live; a section diff keeps the rows that still need Apply.
      if (liveUnit(unit)) {
        const order = source.afterOrder ?? source.beforeOrder ?? []
        return { added: [], removed: [], changed: [], beforeOrder: order, afterOrder: order, orderChanged: false }
      }
      const keep = <Row extends DiffRow | string>(rows: Row[] | undefined): Row[] => (rows ?? []).filter(row => !liveRow(unit, row))
      return { ...source, added: keep(source.added), removed: keep(source.removed), changed: keep(source.changed) }
    }
    return { ...previous, observation: { ...previous.observation, diff: { ...diff, sections: clear('sections'), contexts: clear('contexts'), variables: clear('variables') } } }
  }
  const acknowledge = () => {
    if (working || !acknowledgeBaseline) return Promise.resolve()
    // The acknowledged baseline is pinned to this review epoch, like every other action.
    return call('acknowledgeObservation', [acknowledgeBaseline], () => setReview(clearLiveDiffs), reviewEpoch.current)
  }
  const selectCategory = (unit: Unit): void => { setPreview(null); setSelected(unit) }
  const updateThreshold = (draft: string): void => updateSettings({ draft, dirty: true, error: '', result: false })
  const saveThreshold = (): Promise<void> => saveSettings(settingsRef.current.draft)
  const applySnapshot = (): void => {
    if (disabled || !review) return
    if (review.baselineRequired && !window.confirm(t('confirmRepair'))) return
    void call('applySnapshot', [review.candidate!.revision, review.generation, review.baselineRequired])
  }
  const togglePanel = (): void => {
    if (recovery && ['awaiting-choice', 'pending'].includes(recovery.phase)) { setRecoveryUI(ui => ({ ...ui, open: true })); return }
    if (!open) { ++reviewEpoch.current; setReview(null); setPreview(null); setOpen(true); void refreshReview() } else close()
  }
  return {
    t, state, open, working, review, selected, preview, setPreview, settings,
    recoveryUI, recovery, recoveryError, toast, toastNode, toastPosition,
    pauseToast, resumeToast, close, focusClose, panelId, trigger,
    dismissRecovery, answerRecovery, copyDeferred, shown, stale, changed,
    liveMismatch, settingsError, showAutoInfo, triggerWarning, healthy,
    triggerDescription, childRecoveryNote, disabled, refreshReview, short,
    notification, deltas, hasLiveChanges, acknowledgeVisible, acknowledge,
    selectCategory, updateThreshold, saveThreshold, applySnapshot, togglePanel,
  }
}
