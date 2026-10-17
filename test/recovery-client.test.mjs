import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const flush = () => new Promise(resolve => setImmediate(resolve))
const walk = node => [node, ...(node.children ?? []).flatMap(child => typeof child === 'object' ? walk(child) : [])]
async function harness(language = 'zh') {
  let cursor = 0, component, now = 0, nextTimer = 0
  let cells = [], effects = [], tree, sessionId = 'recovery-test'
  const timers = new Map(), listeners = new Map()
  const react = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) } },
    createPortal: node => node,
    useCallback: fn => fn,
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], v => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { const record = cells[i] = { deps }; effects.push(() => { old?.cleanup?.(); record.cleanup = fn() }) } },
  }
  const sandbox = { exports: {}, REMOTE: {}, require: name => ['react', 'react-dom'].includes(name) ? react : require('../lib/' + name), Date: { now: () => now },
    window: { innerWidth: 400, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) }
  vm.runInNewContext(await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8'), sandbox)
  let latest = { recovery: { id: 'request-1', phase: 'awaiting-choice' }, recoveryOutcome: null, active: { revision: 'A' }, candidate: { revision: 'B' }, generation: 1 }, pendingPoll, pendingAnswer
  const answers = []
  let remote = { summary: async () => pendingPoll ?? { ok: true, value: latest }, status: async () => ({ ok: true, value: latest }), resolveRecovery: async (...args) => { answers.push(args); return pendingAnswer ?? { ok: true, value: latest } } }
  const ctx = { effect: fn => fn(), locale: { register() {} }, remote: { async $mount() {} }, inject(_, fn) { fn(ctx) }, slots: { inject(_, fn) { fn() }, register(_, fn) { component = fn } } }
  await sandbox.exports.apply(ctx)
  const render = () => { cursor = 0; const node = component({ sessionId, promptFreezeRemote: remote, t: require('../lib/locales.cjs').standaloneTranslator(language) }); tree = node.type(node.props); for (const n of walk(tree)) { if (n.props.ref && typeof n.props.ref !== 'function') n.props.ref.current = { focus() {}, contains: target => target === 'inside-toast', getBoundingClientRect: () => ({ left: 300, width: 80, top: 500 }), offsetWidth: 300, offsetHeight: 60 } } effects.splice(0).forEach(fn => fn()); return tree }
  const button = label => walk(tree).find(n => n.type === 'button' && n.children.join('') === label)
  const poll = async () => { const entries = [...timers].filter(([, v]) => v.ms === 4000 || v.ms === 1000); assert(entries.length); const [id, entry] = entries[entries.length - 1]; timers.delete(id); await entry.fn(); render() }
  render(); await flush(); render(); render()
  return { render, button, poll, answers, timers, listeners, get tree() { return tree }, set latest(v) { latest = v }, get latest() { return latest }, set pendingPoll(v) { pendingPoll = v }, set pendingAnswer(v) { pendingAnswer = v }, set now(v) { now = v }, set session(v) { sessionId = v }, set remote(v) { remote = v }, unmount() { cells.forEach(c => c?.cleanup?.()) }, remount() { cells.forEach(c => c?.cleanup?.()); cells = []; effects = []; render() } }
}
for (const language of ['zh', 'en']) test(`recovery estimate ${language}: current, optional and modal-only`, async () => {
  const h = await harness(language)
  const rows = () => walk(h.tree).filter(n => n.props.className === 'pf-recovery-estimate')
  const label = language === 'zh' ? '预计上下文 input：≈ ' : 'Estimated context input: ≈ '
  h.latest = { ...h.latest, autoApply: { inputTokens: 7777, inputStale: true }, recovery: { id: `estimate-${language}`, phase: 'awaiting-choice', estimatedContextInputTokens: 0 } }
  await h.poll(); h.render()
  assert.equal(rows().length, 1); assert.equal(rows()[0].children.join(''), label + '0')
  assert.match(rows()[0].props.title, language === 'zh' ? /上下文投影.*待发送消息.*恢复提示.*缓存未命中.*计费/ : /context projection.*pending messages.*recovery prompt.*cache-miss.*billing/)
  const trigger = () => walk(h.tree).find(n => n.props.className === 'pf-trigger')
  assert(!trigger().props.title.includes(label)); assert(!trigger().props.title.includes('7777'))
  h.latest.recovery.estimatedContextInputTokens = 24000; await h.poll()
  assert.equal(rows()[0].children.join(''), label + '24K')
  for (const value of [undefined, null, -1, '45', NaN, Infinity, 1.5]) {
    h.latest.recovery.estimatedContextInputTokens = value; await h.poll(); assert.equal(rows().length, 0)
    assert(!JSON.stringify(h.tree).includes(language === 'zh' ? '预估 input 不可用' : 'Est. input unavailable'))
  }
  h.latest.recovery.estimatedContextInputTokens = 6000; await h.poll()
  h.button(language === 'zh' ? '关闭' : 'Close').props.onClick(); h.render(); assert.equal(rows().length, 0)
  h.latest.recovery.phase = 'pending'; await h.poll(); trigger().props.onClick(); await flush(); h.render()
  // A pending recovery now raises the dialog too; the estimate the host provided still renders there.
  assert(walk(h.tree).some(n => n.props.className === 'pf-root pf-backdrop'), 'a pending recovery keeps the dialog open')
  assert.equal(rows().length, 1)
  // Once the recovery is gone the trigger opens the panel again, whose settings input stays unlabelled.
  h.latest = { ...h.latest, recovery: null }; await h.poll(); trigger().props.onClick(); await flush(); h.render()
  const input = walk(h.tree).find(n => n.type === 'input')
  assert(input); assert.equal(input.props.title, undefined)
  assert(!walk(h.tree).some(n => n.props.className === 'pf-input'))
  h.unmount()
})
const toastText = h => {
  const toast = walk(h.tree).find(n => n.props.className === 'pf-toast')
  return toast ? walk(toast).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ') : null
}
for (const language of ['zh', 'en']) test(`usage ${language}: pending same id waits for terminal report, preserves disjoint counters and dedups`, async () => {
  const h = await harness(language)
  const outcome = { id: 'usage-same-id', kind: 'kept-changed', usageStatus: 'pending' }
  h.latest = { ...h.latest, recovery: null, recoveryOutcome: outcome }
  await h.poll(); assert.equal(toastText(h), null)
  await h.poll(); assert.equal(toastText(h), null)
  h.latest = { ...h.latest, recoveryOutcome: { ...outcome, usageStatus: 'reported', usage: { inputTokens: 32000, cacheReadTokens: 164000, cacheWriteTokens: 1200 } } }
  await h.poll(); assert.match(toastText(h), /32K \/ 164K/); assert.match(toastText(h), /1\.2K tokens/)
  assert(toastText(h).includes(language === 'zh' ? '缓存写入' : 'Cache write'))
  const timer = [...h.timers].find(([, v]) => v.ms === 5000); assert(timer)
  h.timers.delete(timer[0]); timer[1].fn(); h.render()
  await h.poll(); assert.equal(toastText(h), null)
  h.remount(); await flush(); h.render(); assert.equal(toastText(h), null)
  h.unmount()
})
for (const language of ['zh', 'en']) test(`usage ${language}: absent fields are unavailable, explicit zero stays zero, terminal failures are explicit`, async () => {
  const h = await harness(language)
  const show = async (id, usageStatus, usage) => { h.latest = { ...h.latest, recovery: null, recoveryOutcome: { id, kind: 'recaptured', usageStatus, usage } }; await h.poll(); return toastText(h) }
  let text = await show('missing-cache', 'reported', { inputTokens: 0 })
  assert(text.includes(language === 'zh' ? '0 / 不可用' : '0 / unavailable'))
  assert(!text.includes(language === 'zh' ? '缓存写入' : 'Cache write'))
  text = await show('zero-cache', 'reported', { inputTokens: 2000000, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.match(text, /2M \/ 0/); assert.match(text, /0 tokens/)
  text = await show('no-usage', 'unavailable')
  assert(text.includes(language === 'zh' ? '用量不可用' : 'Usage unavailable'))
  text = await show('no-call', 'not-called')
  assert(text.includes(language === 'zh' ? '没有匹配的模型调用' : 'no matching model call'))
  text = await show('invalid-report', 'reported', {})
  assert(text.includes(language === 'zh' ? '用量不可用' : 'Usage unavailable'))
  h.unmount()
})
test('late usage poll cannot consume new-session outcome with the same id', async () => {
  const h = await harness(); let resolve
  const outcome = { id: 'shared-usage-id', kind: 'recaptured', usageStatus: 'reported', usage: { inputTokens: 12000, cacheReadTokens: 3000 } }
  h.latest = { ...h.latest, recovery: null, recoveryOutcome: { ...outcome, usageStatus: 'pending' } }; await h.poll()
  h.pendingPoll = new Promise(r => { resolve = r }); const polling = h.poll()
  h.session = 'new-usage-session'; h.remote = { summary: async () => ({ ok: true, value: { recovery: null, recoveryOutcome: outcome } }) }; h.render()
  resolve({ ok: true, value: { recovery: null, recoveryOutcome: outcome } }); await polling
  assert.equal(toastText(h), null)
  await h.poll(); assert.match(toastText(h), /12K \/ 3K/)
  h.unmount()
})
test('an unresolved recovery raises its own dialog instead of only a panel warning', async () => {
  const h = await harness('en')
  h.latest = { ...h.latest, recovery: { id: 'pending-test', phase: 'pending' }, recoveryWarning: 'Progress mismatch' }
  await h.poll(); h.render()
  // Pending recovery opens an immediately actionable dialog, before any user send.
  assert(walk(h.tree).some(n => n.props.className === 'pf-root pf-backdrop'), 'the dialog opens for pending')
  const paragraphs = walk(h.tree).filter(n => n.type === 'p').map(n => n.children.join('')).join('')
  assert.equal(paragraphs.split('Choose now; the choice is held in memory').length - 1, 1)
  assert.equal(h.button('Keep the previous snapshot').props.disabled, false)
  assert.equal(h.button('Establish a new snapshot from realtime content').props.disabled, false)
  // With the choice already recorded the trigger opens the panel, which carries exactly one warning.
  h.latest = { ...h.latest, recovery: { id: 'pending-test', phase: 'recapture' }, recoveryWarning: 'Progress mismatch' }
  await h.poll(); h.render()
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); await flush(); h.render()
  const warning = 'Snapshot recovery is unresolved; normal Apply is unavailable. Closing does not authorize execution.'
  const banners = walk(h.tree).filter(n => n.props.role === 'status' && n.props.className === 'pf-live-status pf-warning')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['aria-label'], 'Current live status')
  assert.equal(banners[0].props['aria-live'], 'polite')
  const reasons = walk(banners[0]).filter(n => n.type === 'p').map(n => n.children.join('')).join('')
  assert.equal(reasons.split(warning).length - 1, 1)
  h.unmount()
})

test('same recovery request does not auto-open again after remount; manual reopen remains available', async () => {
  const h = await harness()
  assert(h.button('继续沿用旧快照'))
  h.remount(); await flush(); h.render(); h.render()
  assert(!h.button('继续沿用旧快照'))
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); h.render()
  assert(h.button('继续沿用旧快照'))
  h.unmount()
})
for (const remount of [false, true]) test(`dismissed pending prompt reopens once on real wait, remount=${remount}`, async () => {
  const h = await harness()
  h.latest = { ...h.latest, recovery: { id: 'dismissed-pending', phase: 'pending' } }
  await h.poll()
  assert(h.button('继续沿用旧快照'))
  h.button('关闭').props.onClick(); h.render()
  await h.poll(); assert(!h.button('继续沿用旧快照'))
  assert.equal(h.answers.length, 0)
  h.latest = { ...h.latest, recovery: { id: 'dismissed-pending', phase: 'awaiting-choice' } }
  if (remount) { h.remount(); await flush(); h.render(); h.render() }
  else await h.poll()
  assert.equal(h.button('继续沿用旧快照').props.disabled, false)
  assert.equal(h.button('使用实时内容重新建立快照').props.disabled, false)
  h.button('关闭').props.onClick(); h.render()
  await h.poll(); assert(!h.button('继续沿用旧快照'))
  h.remount(); await flush(); h.render(); h.render()
  assert(!h.button('继续沿用旧快照'), 'same waiting phase remains dismissed across remount')
  assert.equal(h.answers.length, 0)
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); h.render()
  await h.button('继续沿用旧快照').props.onClick()
  assert.deepEqual(h.answers, [['recovery-test', 'dismissed-pending', 'keep']])
  h.unmount()
})
for (const choice of ['keep', 'recapture']) test(`pending ${choice} answer queued across transition retains its identity`, async () => {
  const h = await harness()
  h.latest = { ...h.latest, recovery: { id: 'transition-answer', phase: 'pending' } }
  await h.poll()
  let resolvePoll
  h.pendingPoll = new Promise(resolve => { resolvePoll = resolve })
  const polling = h.poll()
  const answering = h.button(choice === 'keep' ? '继续沿用旧快照' : '使用实时内容重新建立快照').props.onClick()
  h.render()
  assert.equal(h.answers.length, 0)
  resolvePoll({ ok: true, value: { ...h.latest, recovery: { id: 'transition-answer', phase: 'awaiting-choice' } } })
  h.latest = { ...h.latest, recovery: { id: 'transition-answer', phase: choice } }
  await polling; await answering; h.render()
  assert.deepEqual(h.answers, [['recovery-test', 'transition-answer', choice]])
  assert(!h.button('继续沿用旧快照'))
  assert.equal(toastText(h), null, 'recording a choice is not completed recovery')
  h.unmount()
})
test('toast outside pointer dismisses immediately, inside pointer preserves it', async () => {
  const h = await harness()
  h.latest = { ...h.latest, recovery: null, recoveryOutcome: { id: 'outside-test', kind: 'recaptured' } }
  await h.poll(); h.render()
  h.listeners.get('pointerdown')({ target: 'inside-toast' }); h.render()
  assert(toastText(h))
  h.listeners.get('pointerdown')({ target: 'outside' }); h.render()
  assert.equal(toastText(h), null)
  assert(![...h.timers.values()].some(v => v.ms === 5000))
  assert(!h.listeners.has('pointerdown'))
  await h.poll(); assert.equal(toastText(h), null)
  h.unmount()
})
test('recovery dialog width selector outranks generic dialog width', async () => {
  const source = await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8')
  assert(source.includes('.pf-dialog.pf-recovery { width:min(540px,100%); }'))
})
for (const choice of ['keep', 'recapture']) test(`idle pending recovery allows ${choice} without a user send`, async () => {
  const h = await harness()
  h.latest = { ...h.latest, recovery: { id: `idle-${choice}`, phase: 'pending' } }
  await h.poll(); h.render()
  const keep = h.button('继续沿用旧快照'), recapture = h.button('使用实时内容重新建立快照')
  assert.equal(keep.props.disabled, false)
  assert.equal(recapture.props.disabled, false)
  assert(walk(h.tree).some(n => n.children.some(c => typeof c === 'string' && c.includes('仅在内存登记'))))
  let resolve
  h.pendingAnswer = new Promise(r => { resolve = r })
  const answer = (choice === 'keep' ? keep : recapture).props.onClick()
  h.render()
  assert(h.button('继续沿用旧快照').props.disabled)
  assert(h.button('使用实时内容重新建立快照').props.disabled)
  h.button('继续沿用旧快照').props.onClick()
  assert.deepEqual(h.answers, [['recovery-test', `idle-${choice}`, choice]])
  h.latest = { ...h.latest, recovery: { id: `idle-${choice}`, phase: choice } }
  resolve({ ok: true, value: h.latest }); await answer; h.render()
  assert(!h.button('继续沿用旧快照'))
  assert(!walk(h.tree).some(n => n.props.className === 'pf-toast'), 'selection is not reported as completed recovery')
  h.unmount()
})

test('recovery dialog queues answer behind polling, dismisses without consent, and persists errors', async () => {
  const h = await harness()
  assert(h.button('继续沿用旧快照'))
  walk(h.tree).find(n => n.props.className === 'pf-root pf-backdrop').props.onKeyDown({ key: 'Escape', stopPropagation() {} }); h.render()
  assert.equal(h.answers.length, 0)
  await h.poll(); assert(!h.button('继续沿用旧快照'))
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); h.render()
  let resolvePoll, resolveAnswer
  h.pendingPoll = new Promise(r => { resolvePoll = r }); h.pendingAnswer = new Promise(r => { resolveAnswer = r })
  const polling = h.poll(); const answering = h.button('继续沿用旧快照').props.onClick(); h.render()
  assert.equal(h.answers.length, 0); assert(h.button('继续沿用旧快照').props.disabled)
  h.button('使用实时内容重新建立快照').props.onClick()
  resolvePoll({ ok: true, value: h.latest }); await polling; await flush()
  assert.deepEqual(h.answers, [['recovery-test', 'request-1', 'keep']])
  resolveAnswer({ ok: false, error: { message: 'persist failed' } }); await answering; h.pendingPoll = null; h.render()
  await h.poll(); assert(walk(h.tree).some(n => n.props.role === 'alert' && n.children.includes('persist failed')))
  h.pendingAnswer = null; h.latest = { ...h.latest, recovery: { id: 'request-1', phase: 'recapture' } }
  await h.button('使用实时内容重新建立快照').props.onClick(); h.render()
  assert.equal(h.answers[1][2], 'recapture'); assert(!h.button('继续沿用旧快照'))
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); await flush(); h.render()
  assert(h.button('应用此版本').props.disabled)
  h.unmount()
})
test('an automatic keep in a delegated session is surfaced in the parent panel', async () => {
  const h = await harness('en')
  h.latest = { ...h.latest, recovery: null, childRecoveries: [{ sessionId: 'child-session-1', kind: 'auto-kept-changed', label: 'probe' }] }
  await h.poll(); h.render()
  walk(h.tree).find(n => n.props.className === 'pf-trigger').props.onClick(); await flush(); h.render()
  const note = walk(h.tree).find(n => n.props.className === 'pf-note' && n.children.join('').includes('Delegated session'))
  assert(note, 'the parent panel names the delegated session')
  assert.match(note.children.join(''), /probe/)
  assert.match(note.children.join(''), /no confirmation/)
  // A session without child recoveries shows nothing of the sort.
  h.latest = { ...h.latest, childRecoveries: null }; await h.poll(); h.render()
  assert(!walk(h.tree).some(n => n.props.className === 'pf-note' && n.children.join('').includes('Delegated session')))
  h.unmount()
})

test('outcome toasts use translated labels, dedup on polls/remount, pause timer and clean listeners', async () => {
  const h = await harness()
  const labels = ['已继续沿用旧快照，当前内容无变化。', '已继续沿用旧快照，新内容已进入待审核。', '已使用实时内容建立新快照。']
  for (const [i, kind] of ['kept-unchanged', 'kept-changed', 'recaptured'].entries()) {
    h.latest = { ...h.latest, recovery: null, recoveryOutcome: { id: 'outcome-' + i, kind } }; await h.poll(); h.render()
    let toast = walk(h.tree).find(n => n.props.className === 'pf-toast')
    assert.equal(toast.children[0], labels[i]); assert.equal(toast.props['aria-live'], 'polite'); assert(toast.props.style.left >= 8); assert(toast.props.style.top < 500)
    assert(h.listeners.has('scroll')); h.now = i * 5000 + 1200; toast.props.onMouseEnter(); assert(![...h.timers.values()].some(v => v.ms === 5000))
    h.now = i * 5000 + 2400; toast.props.onMouseLeave(); const entry = [...h.timers].find(([, v]) => v.ms !== 4000 && v.ms !== 1000); assert(entry); assert(entry[1].ms <= 5000)
    h.timers.delete(entry[0]); entry[1].fn(); h.render(); assert(!walk(h.tree).some(n => n.props.className === 'pf-toast'))
    await h.poll(); assert(!walk(h.tree).some(n => n.props.className === 'pf-toast'))
  }
  h.remount(); await flush(); h.render(); assert(!walk(h.tree).some(n => n.props.className === 'pf-toast')); h.unmount(); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0)
})
test('session replacement ignores late recovery response and keeps new session outcome scope', async () => {
  const h = await harness(); let resolve
  h.pendingAnswer = new Promise(r => { resolve = r })
  const answering = h.button('继续沿用旧快照').props.onClick()
  h.session = 'different-session'; h.remote = { summary: async () => ({ ok: true, value: { recovery: { id: 'new-request', phase: 'awaiting-choice' } } }) }; h.render()
  resolve({ ok: true, value: { recovery: null, recoveryOutcome: { id: 'obsolete', kind: 'recaptured' } } }); await answering; await h.poll(); h.render()
  assert(h.button('继续沿用旧快照')); assert(!walk(h.tree).some(n => n.props.className === 'pf-toast')); h.unmount()
})

test('queued recovery answer is discarded on remote/session replacement', async () => {
  const h = await harness(); let resolve
  h.pendingPoll = new Promise(r => { resolve = r })
  const polling = h.poll()
  const answering = h.button('继续沿用旧快照').props.onClick()
  h.session = 'queued-new-session'
  h.remote = { summary: async () => ({ ok: true, value: { recovery: { id: 'fresh-request', phase: 'awaiting-choice' } } }), resolveRecovery: async (...args) => { h.answers.push(args); return { ok: true, value: { recovery: null, recoveryOutcome: { id: 'fresh-outcome', kind: 'recaptured' }, recoveryWarning: 'notifications reset' } } } }
  h.render()
  resolve({ ok: true, value: h.latest }); await polling; await answering; await h.poll()
  assert.equal(h.answers.length, 0, 'obsolete queued answer never sent to either remote')
  await h.button('使用实时内容重新建立快照').props.onClick(); h.render()
  assert.deepEqual(h.answers, [['queued-new-session', 'fresh-request', 'recapture']])
  assert(walk(h.tree).find(n => n.props.className === 'pf-trigger').props.title.includes('快照恢复已完成'))
  assert(walk(h.tree).some(n => n.props.className === 'pf-toast'))
  h.remount(); await flush(); h.render(); assert(!walk(h.tree).some(n => n.props.className === 'pf-toast'))
  h.unmount()
})

for (const language of ['zh', 'en']) test(`recovery guidance ${language}: unchanged offers either choice, changed recommends the new snapshot`, async () => {
  const t = require('../lib/locales.cjs').standaloneTranslator(language)
  const h = await harness(language)
  const notes = () => walk(h.tree).filter(n => n.props.className === 'pf-note').map(n => n.children.join(''))
  const paragraphs = () => walk(h.tree).filter(n => n.type === 'p').map(n => n.children.join(''))
  h.latest = { ...h.latest, recovery: { id: 'request-1', phase: 'awaiting-choice', frozenContentMatches: true } }; await h.poll()
  assert(notes().includes(t('recoveryUnchangedHelp')), 'matching frozen content explains that either choice is equivalent')
  assert(!notes().includes(t('recoveryChangedHelp')))
  h.latest = { ...h.latest, recovery: { id: 'request-1', phase: 'awaiting-choice', frozenContentMatches: false } }; await h.poll()
  assert(notes().includes(t('recoveryChangedHelp')), 'changed frozen content recommends the new snapshot')
  assert(!notes().includes(t('recoveryUnchangedHelp')))
  // Without a comparable candidate and saved revision the dialog keeps its neutral policy text.
  h.latest = { ...h.latest, recovery: { id: 'request-1', phase: 'awaiting-choice' } }; await h.poll()
  assert(!notes().some(note => note === t('recoveryChangedHelp') || note === t('recoveryUnchangedHelp')))
  assert(paragraphs().includes(t('recoveryChoiceHelp')), 'the neutral policy text remains')
  h.unmount()
})

test('closing the recovery dialog is local: nothing is authorized, sent, or lost', async () => {
  const t = require('../lib/locales.cjs').standaloneTranslator('zh')
  const h = await harness('zh')
  const dialog = () => walk(h.tree).find(n => n.props.className === 'pf-dialog pf-recovery')
  assert(dialog())
  h.button('关闭').props.onClick(); h.render()
  assert(!dialog(), 'closing only hides the dialog')
  assert.equal(h.answers.length, 0, 'closing is not an answer')
  assert([...h.timers.values()].some(timer => timer.ms === 4000 || timer.ms === 1000), 'background polling continues while it is hidden')
  const trigger = () => walk(h.tree).find(n => n.props.className === 'pf-trigger')
  assert(trigger().props.title.includes(t('recoveryWaiting')), 'the pending choice stays surfaced on the trigger')
  assert.equal(trigger().props['aria-expanded'], false, 'only the dialog is hidden')
  // The same pending request can still be answered after reopening from the trigger.
  trigger().props.onClick(); h.render()
  assert(dialog(), 'clicking Prompt Freeze reopens the pending choice')
  await h.button('继续沿用旧快照').props.onClick(); await flush(); h.render()
  assert.deepEqual(h.answers, [['recovery-test', 'request-1', 'keep']], 'the request id survived the dismissal')
  h.unmount()
})
