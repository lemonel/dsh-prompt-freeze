import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
async function sourceClient(react, globals) {
  const sandbox = { ...globals, exports: {}, REMOTE: {}, require: name => name === 'react' || name === 'react-dom' ? react : require('../lib/' + name) }
  vm.runInNewContext(await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8'), sandbox)
  return sandbox.exports
}
import { readFile } from 'node:fs/promises'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptFreeze } from '../lib/host.mjs'
import { PACKAGE, descriptors } from '../lib/contract.mjs'

test('panel interaction pins review B while polling C; explicit re-review fetches D before applying D', async () => {
  let definition, component, cursor = 0, timer
  const cells = [], effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useCallback(callback) { return callback },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useEffect(callback) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(callback) } },
  }
  const status = revision => ({ sessionId: 's', generation: 1, busy: false, baselineRequired: false, noticeState: 'none', active: { revision: 'A' }, candidate: { revision, tools: [] }, kept: revision, diff: { added: [revision], removed: [], changed: [] } })
  let latest = status('B'), pendingStatus, pendingSummary, statusCalls = 0, summaryCalls = 0; const applied = []
  const compact = value => {
    if (value instanceof Error) throw value
    if (value?.ok === false) return value
    const { diff, observation, kept, ...metadata } = value
    return { ok: true, value: { ...metadata, active: value.active && { revision: value.active.revision }, candidate: value.candidate && { revision: value.candidate.revision } } }
  }
  const remote = { async summary() { ++summaryCalls; return pendingSummary ?? compact(latest) }, async status() { ++statusCalls; if (pendingStatus) return pendingStatus; if (latest instanceof Error) throw latest; return latest?.ok === false ? latest : { ok: true, value: latest } }, async applySnapshot(...args) { applied.push(args); return { ok: true, value: latest } } }
  const sandbox = { window: { confirm: () => true, __ModuleLoader__: { load(v) { definition = v } } }, setTimeout(callback) { timer = callback; return 1 }, clearTimeout() {}, console }
  const client = await sourceClient(react, sandbox)
  const ctx = { effect: fn => fn(), locale: { register() { return () => {} } }, remote: { promptFreeze: remote, async $mount() { return () => {} } }, inject(_, cb) { cb(ctx) }, slots: { inject(_, cb) { cb() }, register(_, cb) { component = cb } } }
  await client.apply(ctx)
  const element = component({ sessionId: 's', promptFreezeRemote: remote })
  const render = () => { cursor = 0; return element.type(element.props) }
  const walk = tree => [tree, ...tree.children?.flatMap(child => typeof child === 'object' ? walk(child) : []) ?? []]
  const button = (tree, label) => walk(tree).find(n => n.type === 'button' && n.children.join('') === label)
  const eye = label => walk(tree).find(n => n.type === 'button' && n.props['aria-label'] === `查看${label}差异`)
  const previews = () => walk(tree).filter(n => n.props.className === 'pf-diff')
  const text = node => typeof node === 'object' ? node.children.map(text).join('') : String(node)
  const clickEye = label => {
    let prevented = false, stopped = false
    eye(label).props.onClick({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert(prevented && stopped, 'eye handles its own toggle without bubbling')
    tree = render()
  }
  let tree = render()
  const assertNoInitialIcon = () => assert.equal(walk(walk(tree).find(n => n.props.className === 'pf-trigger')).filter(n => n.type === 'svg').length, 0)
  assertNoInitialIcon()
  const cleanups = effects.map(effect => effect()); tree = render(); assertNoInitialIcon()
  await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(summaryCalls, 1)
  assert.equal(statusCalls, 0, 'initial closed polling never requests full details')
  let resolveSummary
  pendingSummary = new Promise(resolve => { resolveSummary = resolve })
  const deferredPoll = timer()
  walk(tree).find(n => n.type === 'button').props.onClick(); tree = render()
  assert.equal(statusCalls, 0, 'opening waits for in-flight summary')
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  assert(!walk(tree).some(n => n.children?.includes('无内容变化')))
  assert(walk(tree).some(n => n.children?.includes('正在读取完整审阅，请稍候…')))
  resolveSummary(compact(latest)); await deferredPoll; pendingSummary = null
  await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(statusCalls, 1, 'queued opening makes exactly one full request')
  assert.equal(button(tree, '应用此版本').props.disabled, false)
  const trigger = () => walk(tree).find(n => n.props.className === 'pf-trigger')
  const banner = () => walk(tree).find(n => n.props.className?.startsWith('pf-live-status '))
  const bannerText = () => banner()?.children.find(n => n.type === 'p').children.join('')
  const assertWarning = (reason, healthy = !reason) => {
    if (reason) {
      assert.equal(banner()?.props.className, 'pf-live-status pf-warning')
      assert(bannerText().includes(reason), 'normal dialog explains the black icon')
      assert(trigger().props.title.includes(bannerText()), 'entry and dialog share live reasons')
    } else assert.equal(banner(), undefined, 'banner disappears when reasons clear')
    const icons = walk(trigger()).filter(n => n.type === 'svg')
    assert.equal(icons.length, reason || healthy ? 1 : 0)
    assert.equal(trigger().props.title.includes('当前候选与活动快照一致'), healthy)
    assert.equal(trigger().props['aria-label'].includes('当前候选与活动快照一致'), healthy)
    if (healthy) {
      assert.equal(icons[0].props.width, 14)
      assert.equal(icons[0].props.height, 14)
      assert.equal(icons[0].props['aria-hidden'], true)
      assert.equal(icons[0].props.focusable, false)
      assert.equal(icons[0].children[0].props.stroke, '#22c55e')
      assert.equal(icons[0].children[0].props.d, 'M5 12l4 4L19 6')
    }
    assert.equal(trigger().children[0], 'Prompt Freeze')
    if (reason) {
      assert(trigger().props.title.includes(reason))
      assert(trigger().props['aria-label'].includes(reason))
      assert.equal(icons[0].props['aria-hidden'], true)
      assert.equal(icons[0].props.focusable, false)
      assert.deepEqual(icons[0].children.map(n => [n.type, n.props.fill, n.props.d]), [
        ['path', '#000', 'M12 2 23 22H1Z'], ['path', '#fff', 'M11 8h2v7h-2zM11 17h2v2h-2z'],
      ])
    } else {
      assert(trigger().props['aria-label'].startsWith('Prompt Freeze；'))
      assert(!trigger().props['aria-label'].includes('预估 input'))
    }
  }
  const assertPinnedB = () => assert(walk(tree).some(n => n.type === 'p' && n.children.join('').includes('待应用快照：B')))
  assertWarning('当前候选与活动快照存在差异')
  for (const noticeState of ['pending', 'committed-not-durable', 'in-history']) {
    latest = { ...status('A'), noticeState }
    await timer(); tree = render()
    assertWarning(null)
    assertPinnedB()
    assert.equal(button(tree, '应用此版本').props.disabled, true)
  }
  for (const [field, value, reason] of [
    ['error', 'registration flush failed', '错误：registration flush failed'],
    ['recoveryWarning', 'invalidated', '恢复警告'],
    ['checkpointError', 'flush failed', '进度持久化或清理警告：flush failed'],
    ['autoApply', { error: 'auto failed' }, '自动应用不可用：auto failed'],
    ['autoApply', { settingsError: 'invalid threshold' }, '设置错误：invalid threshold'],
    ['recovery', { id: 'failed-recovery', phase: 'resolving', error: 'recovery failed' }, '错误：recovery failed'],
  ]) {
    latest = { ...status('A'), [field]: value }
    await timer(); tree = render()
    assertWarning(reason)
    assert(!trigger().props.title.includes('当前候选与活动快照存在差异'))
    assertPinnedB()
  }
  latest = status('A'); await timer(); tree = render()
  latest = new Error('status failed'); await timer(); tree = render()
  assertWarning('错误：status failed')
  for (const missing of [{ candidate: null }, { active: null }, { active: null, candidate: null }, { active: {}, candidate: {} }, { active: { revision: '' }, candidate: { revision: '' } }]) {
    latest = { ...status('B'), ...missing }
    await timer(); tree = render()
    assertWarning(null, false)
    assertPinnedB()
  }
  for (const flag of ['awaitingFirstCall', 'baselineRequired', 'upgradeRequired', 'registrationError', 'registrationPending']) {
    latest = { ...status('A'), [flag]: true }
    await timer(); tree = render(); assertWarning(null, false)
  }
  latest = { ...status('A'), recovery: { id: 'healthy-blocked', phase: 'resolving' }, recoveryWarning: 'invalidated' }
  await timer(); tree = render(); assertWarning('快照恢复尚未完成')
  assert.equal(bannerText().split('快照恢复尚未完成').length - 1, 1)
  assert.equal(trigger().props.title.split('快照恢复尚未完成').length - 1, 1)
  latest = { ...status('A'), recoveryWarning: 'invalidated', recoveryOutcome: { kind: 'other' } }
  await timer(); tree = render(); assertWarning('旧的待发通知已丢弃')
  latest = { ...status('A'), busy: true }
  await timer(); tree = render(); assertWarning(null)
  pendingSummary = new Promise(resolve => { resolveSummary = resolve })
  const healthyPoll = timer(); tree = render(); assertWarning(null)
  resolveSummary(compact(latest)); await healthyPoll; pendingSummary = null
  tree = render(); assertWarning(null)
  // Render with the same hook state for the localized trigger.
  cursor = 0
  const englishTree = element.type({ ...element.props, t: require('../lib/locales.cjs').standaloneTranslator('en') })
  const englishTrigger = walk(englishTree).find(n => n.props.className === 'pf-trigger')
  assert(englishTrigger.props.title.includes('Current candidate matches the active snapshot'))
  assert(englishTrigger.props['aria-label'].includes('Current candidate matches the active snapshot'))
  for (const [inputTokens, label] of [[12500, '12.5K'], [1250000, '1.25M'], [0, '0']]) {
    latest = { ...status('B'), autoApply: { thresholdTokens: 2000000, inputTokens, eligible: true } }
    await timer(); tree = render()
    const icon = walk(trigger()).find(n => n.type === 'svg')
    assert.equal(banner()?.props.className, 'pf-live-status pf-info')
    assert(bannerText().includes('待自动应用（尚未生效）'))
    assert(trigger().props.title.includes(bannerText()))
    assert.equal(icon.children[0].type, 'circle')
    assert.equal(icon.children[0].props.stroke, '#3b82f6')
    assert.equal(icon.children[1].props.d, 'M11 10h2v8h-2zM11 6h2v2h-2z')
    assert.equal(icon.props['aria-hidden'], true)
    assert.equal(icon.props.focusable, false)
    assert(trigger().props.title.includes('尚未生效'))
    assert(trigger().props['aria-label'].includes('下一条真实用户消息'))
    assert(!walk(trigger()).some(n => n.props.className === 'pf-input'))
    assert(!trigger().props.title.includes(`≈${label}`))
    assert(walk(tree).some(n => n.type === 'input' && n.props.title === undefined))
    assert(walk(tree).some(n => n.props.className === 'pf-threshold-hint' && n.children.join('').includes('预估输入低于此值')))
    assertPinnedB()
    assert.equal(applied.length, 0, 'eligible polling never auto-applies from UI')
  }
  for (const [extra, reason] of [
    [{ error: 'request failure' }, 'request failure'],
    [{ recoveryWarning: 'invalidated' }, '恢复警告'],
    [{ checkpointError: 'checkpoint failure' }, 'checkpoint failure'],
    [{ autoApply: { thresholdTokens: 2000000, inputTokens: 100, eligible: true, error: 'estimate failure' } }, 'estimate failure'],
  ]) {
    latest = { ...status('B'), autoApply: { thresholdTokens: 2000000, inputTokens: 100, eligible: true }, ...extra }
    await timer(); tree = render()
    assertWarning(reason)
    assert(trigger().props.title.includes('尚未生效'), 'pending explanation survives warning priority')
  }
  latest = { ...status('B'), autoApply: { thresholdTokens: 2000000, inputTokens: 100, eligible: true } }
  await timer(); tree = render()
  latest = new Error('network failure'); await timer(); tree = render()
  assertWarning('network failure')
  assert(trigger().props.title.includes('尚未生效'))
  for (const inputTokens of [2000000, null]) {
    latest = { ...status('B'), autoApply: { thresholdTokens: 2000000, inputTokens, eligible: false } }
    await timer(); tree = render()
    assertWarning('当前候选与活动快照存在差异')
    assert.equal(button(tree, '应用此版本').props.disabled, false)
    assert(trigger().props.title.includes('手动应用'))
    assert(!JSON.stringify(trigger()).includes('预估 input 不可用'))
  }
  latest = { ...status('A'), autoApply: { thresholdTokens: 2000000, inputTokens: 100, eligible: true } }
  await timer(); tree = render(); assertWarning(null)
  latest = { ...status('B'), autoApply: { thresholdTokens: null, inputTokens: null, eligible: false, error: 'invalid config' } }
  await timer(); tree = render(); assertWarning('当前候选与活动快照存在差异')
  assert(trigger().props.title.includes('invalid config'))
  // Settings revisions are independent of the pinned snapshot generation.
  const saves = []
  const settingsStatus = (revision, override, thresholdTokens = 24000) => ({ ...status('B'), autoApply: { thresholdTokens, inputTokens: 100, eligible: true, settingsRevision: revision, override, defaultThresholdTokens: 24000 } })
  latest = settingsStatus(4, null); await timer(); tree = render()
  const input = () => walk(tree).find(n => n.type === 'input')
  const edit = value => { input().props.onChange({ target: { value } }); tree = render() }
  assert.equal(input().props.value, '24K')
  assert.equal(input().props['aria-label'], '会话阈值')
  latest = settingsStatus(5, '32K', 32000); await timer(); tree = render()
  assert.equal(input().props.value, '32K', 'clean draft follows another page')
  edit('2M')
  latest = settingsStatus(6, '40K', 40000); await timer(); tree = render()
  assert.equal(input().props.value, '2M', 'dirty draft survives another page')
  assert.equal(button(tree, '保存会话阈值'), undefined)
  assert(walk(tree).some(n => n.type === 'label' && n.props.htmlFor === input().props.id))
  assertPinnedB()
  assert.equal(button(tree, '重新载入设置'), undefined)
  assert.equal(input().props.value, '2M')
  remote.setAutoApply = async (...args) => {
    saves.push(args)
    latest = settingsStatus(args[2] + 1, args[1], args[1] === '' ? null : args[1] === null ? 24000 : 2000000)
    return { ok: true, value: latest }
  }
  const reviewCallsBeforeSave = statusCalls
  pendingSummary = new Promise(resolve => { resolveSummary = resolve })
  const settingsPoll = timer(); tree = render()
  const queuedSave = input().props.onBlur()
  await input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.equal(saves.length, 0, 'blur queues behind poll and Enter does not duplicate it')
  resolveSummary(compact(latest)); await settingsPoll; await queuedSave; pendingSummary = null; tree = render()
  assert.equal(saves.length, 1)
  await input().props.onBlur()
  assert.equal(saves.length, 1, 'unchanged blur does not save')
  edit('3M'); edit('2M'); await input().props.onBlur(); tree = render()
  assert.equal(saves.length, 1, 'edit then revert does not save on blur')
  edit('4M'); edit('2M'); await input().props.onKeyDown({ key: 'Enter', preventDefault() {} }); tree = render()
  assert.equal(saves.length, 1, 'edit then revert does not save on Enter')
  assert.deepEqual(saves.at(-1), ['s', '2M', 6])
  assert.equal(statusCalls, reviewCallsBeforeSave)
  assertPinnedB()
  assert.equal(button(tree, '应用此版本').props.disabled, false, 'settings revision does not expire review')
  assert.equal(button(tree, '使用默认值'), undefined)
  edit('24K'); await input().props.onKeyDown({ key: 'Enter', isComposing: true, preventDefault() { assert.fail('IME must not submit') } })
  assert.equal(saves.length, 1)
  await input().props.onKeyDown({ key: 'Enter', preventDefault() {} }); tree = render()
  assert.deepEqual(saves.at(-1), ['s', '24K', 7])
  edit(''); await input().props.onBlur(); tree = render()
  assert.deepEqual(saves.at(-1), ['s', '', 8])
  assert.equal(input().props.value, '')
  assert.equal(applied.length, 0)
  latest = { ...settingsStatus(9, ''), candidate: { revision: 'A' } }
  await timer(); tree = render(); assertWarning(null)
  edit('8K')
  latest = { ...latest, autoApply: { ...latest.autoApply, settingsRevision: 10 } }
  await timer(); tree = render(); assertWarning(null, false)
  let finishSave
  remote.setAutoApply = (...args) => { saves.push(args); return new Promise(resolve => { finishSave = resolve }) }
  edit('8K'); const saving = input().props.onBlur(); tree = render()
  assert.equal(input().props.disabled, true)
  assertWarning(null, false)
  await timer(); tree = render()
  assert(walk(tree).some(n => n.children?.includes('正在保存设置…')))
  finishSave({ ok: false, error: { message: 'stale settings' } }); await saving; tree = render()
  await timer(); tree = render()
  assert(walk(tree).some(n => n.children?.includes('设置错误：stale settings')))
  assert.equal(input().props.value, '8K')
  const closingSave = input().props.onBlur(); tree = render()
  button(tree, '关闭').props.onClick(); tree = render()
  finishSave({ ok: true, value: settingsStatus(99, '99K', 99000) }); await closingSave; tree = render()
  assert(!walk(tree).some(n => n.props.role === 'dialog'))
  latest = settingsStatus(10, '')
  trigger().props.onClick(); await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(input().props.value, '8K', 'closed response cannot overwrite dirty draft')
  assert.equal(statusCalls, reviewCallsBeforeSave + 1)
  latest = status('C'); await timer(); tree = render()
  assertWarning('当前候选与活动快照存在差异')
  assertPinnedB()
  assert(walk(tree).some(n => n.props.className === 'pf-note pf-pinned-help' && n.children.join('').includes('可能与实时状态不同')))
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  button(tree, '应用此版本').props.onClick(); assert.equal(applied.length, 0)
  assert(walk(tree).some(n => n.type === 'p' && n.children.join('').includes('待应用快照：B')))
  assert.equal(button(tree, '刷新'), undefined)
  assert.equal(statusCalls, reviewCallsBeforeSave + 1, 'only explicit reopening fetched another review')
  latest = status('D') // Not polled: fetch D rather than adopting cached C.
  const callsBeforeReview = statusCalls
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(statusCalls, callsBeforeReview + 1)
  assert(walk(tree).some(n => n.children?.join('').includes('待应用快照：D')))
  button(tree, '应用此版本').props.onClick(); await new Promise(r => setImmediate(r))
  assert.equal(applied.length, 1); assert.deepEqual(Array.from(applied[0]), ['s', 'D', 1, false])
  latest = { ...status('D'), recoveryWarning: 'invalidated', checkpointError: 'flush failed', active: null, generation: 0, awaitingFirstCall: true }
  await timer(); tree = render()
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  assert.equal(button(tree, '保留活动版本'), undefined)
  assert(!walk(tree).some(n => n.children?.join('').includes('已选择保留活动版本')))
  assert(walk(tree).some(n => n.type === 'p' && n.children.join('').includes('首次实际模型 API')))
  assert(bannerText().includes('旧工具快照及待发通知已失效'))
  assert(bannerText().includes('进度持久化或清理警告：flush failed'))
  button(tree, '应用此版本').props.onClick(); assert.equal(applied.length, 1)
  latest = { ...status('E'), recoveryWarning: 'invalidated' }
  await timer(); tree = render()
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(button(tree, '应用此版本').props.disabled, false, 'recovery warning must not block normal review after recapture')
  latest = { ...status('Upgrade'), upgradeRequired: true, diff: { ...status('Upgrade').diff, sections: { added: [{ name: 'tool:pipeline', text: 'exact added' }], removed: [], changed: [], beforeOrder: [], afterOrder: ['tool:pipeline'], orderChanged: true } } }
  await timer(); tree = render(); await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(button(tree, '应用并启用 section 冻结').props.disabled, false)
  const category = (tree, name) => walk(tree).find(n => n.type === 'button' && n.children.some(c => c.type === 'strong' && c.children[0].endsWith(` ${name}`)))
  category(tree, 'sections').props.onClick(); tree = render()
  assert.equal(category(tree, 'sections').props['aria-expanded'], true)
  assert(eye('tool:pipeline'))
  assert.equal(previews().length, 0)
  clickEye('tool:pipeline')
  assert(walk(tree).some(n => n.props.className === 'pf-diff-line pf-diff-add' && walk(n).some(c => c.children?.includes('exact added'))))
  assert(walk(tree).some(n => n.type === 'p' && n.children.join('').includes('需要审阅升级')))
  button(tree, '应用并启用 section 冻结').props.onClick(); await new Promise(r => setImmediate(r))
  assert.deepEqual(Array.from(applied.at(-1)), ['s', 'Upgrade', 1, false])
  const delta = { added: [], removed: [], changed: [{ name: 'runtime-key', before: { value: 'old' }, after: { value: 'new' } }], beforeOrder: ['runtime-key'], afterOrder: ['runtime-key'], orderChanged: false }
  latest = { ...status('Live'), active: { revision: 'Live' }, observation: { baselineAvailable: true, current: {}, diff: { contexts: delta, variables: delta } } }
  await timer(); tree = render(); await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  category(tree, 'contexts').props.onClick(); tree = render()
  assert(!eye('runtime-key'), 'context value without rendered text is not a text modification')
  category(tree, 'variables').props.onClick(); tree = render()
  assert(eye('runtime-key'))
  assert(walk(category(tree, 'variables')).some(n => text(n) === '新增 0 个 · 删除 0 个 · 修改 1 个'))
  clickEye('runtime-key')
  assert(walk(tree).some(n => n.children?.includes('  "value": "new"')))
  latest = { ...latest, observation: { baselineAvailable: false, current: {}, diff: null } }
  await timer(); tree = render(); await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert(walk(tree).some(n => n.type === 'p' && n.children.join('').includes('观察基线不可用')))
  const empty = { added: [], removed: [], changed: [], orderChanged: false }
  latest = { ...status('Full'), observation: { baselineAvailable: true, diff: {
    tools: { ...empty, added: [{ name: 'new-tool', description: 'new description', parameters: { type: 'object' }, deferLoading: true }], removed: [{ name: 'old-tool', description: 'old description' }], changed: [{ name: 'same-tool', before: { description: 'before' }, after: { description: 'after' } }] },
    sections: { ...empty, changed: [{ name: 'live-marker', before: { text: 'same', live: false }, after: { text: 'same', live: true } }], orderChanged: true },
    contexts: { ...empty, changed: [{ name: 'context', before: { text: 'old text' }, after: { text: 'new text' } }] },
    variables: { ...empty, added: [{ name: 'undefined-key', defined: false }], removed: [{ name: 'absent-key', defined: true, value: '' }] }
  } } }
  await timer(); tree = render(); await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  category(tree, 'tools').props.onClick(); tree = render()
  assert(walk(category(tree, 'tools')).some(n => text(n) === '新增 1 个 · 删除 1 个 · 修改 1 个'))
  const assertEyeOnlyItems = () => {
    const items = walk(tree).filter(n => n.props.className === 'pf-item-header')
    assert(items.length)
    for (const header of items) {
      assert.equal(header.type, 'div')
      assert.equal(header.props.onClick, undefined)
      assert.equal(header.props.tabIndex, undefined)
      assert.equal(walk(header).filter(n => n.type === 'button').length, 1)
    }
    assert.deepEqual(walk(tree).filter(n => n.type === 'summary').map(n => n.children.join('')), ['顺序变化：否（不计入修改）', '冻结范围与兼容性'])
    assert(!walk(tree).some(n => n.props.className === 'pf-value' || n.type === 'pre'))
    assert.equal(button(tree, '保留活动版本'), undefined)
  }
  assertEyeOnlyItems()
  assert(walk(tree).some(n => n.children?.includes('点击眼睛查看差异：红色为删除，绿色为新增。')))
  assert.equal(previews().length, 0, 'diff is lazy before eye request')
  assert(walk(eye('same-tool')).some(n => n.type === 'svg'))
  clickEye('same-tool')
  assert.equal(eye('same-tool').props['aria-expanded'], true)
  const controlled = walk(tree).find(n => n.props.id === eye('same-tool').props['aria-controls'])
  assert.equal(controlled.props.hidden, false)
  assert(walk(tree).some(n => n.props.className === 'pf-item' && n.children.includes(controlled) && n.children.some(c => c.props?.className === 'pf-item-header')), 'eye preview follows noninteractive item header')
  assertEyeOnlyItems()
  assert(walk(tree).some(n => n.props.className === 'pf-diff-line pf-diff-remove'))
  assert(walk(tree).some(n => n.props.className === 'pf-diff-line pf-diff-add'))
  assert(walk(tree).some(n => n.props.className === 'pf-diff-line'))
  clickEye('same-tool'); assert.equal(previews().length, 0)
  clickEye('new-tool'); assert.equal(previews().length, 1)
  clickEye('old-tool'); assert.equal(previews().length, 1)
  assert.equal(eye('new-tool').props['aria-expanded'], false)
  clickEye('新增'); assert.equal(previews().length, 1)
  assert.equal(eye('old-tool').props['aria-expanded'], false)
  assert.equal(previews()[0].props['aria-label'], 'new-tool统一差异')
  clickEye('删除'); assert.equal(previews()[0].props['aria-label'], 'old-tool统一差异')
  clickEye('修改'); assert.equal(previews()[0].props['aria-label'], 'same-tool统一差异')
  category(tree, 'sections').props.onClick(); tree = render()
  assert.equal(previews().length, 0, 'category change clears preview')
  assert(walk(category(tree, 'sections')).some(n => text(n) === '新增 0 个 · 删除 0 个 · 修改 0 个'))
  assert(walk(tree).some(n => n.type === 'summary' && n.children.includes('顺序变化：是（不计入修改）')))
  category(tree, 'contexts').props.onClick(); tree = render()
  assertEyeOnlyItems()
  clickEye('context')
  assert(walk(tree).some(n => n.children?.includes('new text')))
  category(tree, 'variables').props.onClick(); tree = render()
  assertEyeOnlyItems()
  clickEye('undefined-key')
  assert(walk(tree).some(n => n.children?.some(c => typeof c === 'string' && c.includes('undefined'))))
  clickEye('absent-key')
  assert.equal(previews().length, 1)
  assert(walk(tree).some(n => n.props.className === 'pf-diff-line pf-diff-remove'))
  latest.observation.diff.variables.added.push({ name: 'second-key', defined: true, value: 'second' })
  await timer(); tree = render(); await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  clickEye('新增')
  assert.equal(previews().length, 2, 'aggregate eye includes every item in group')
  assert.deepEqual(previews().map(n => n.props['aria-label']), ['undefined-key统一差异', 'second-key统一差异'])
  clickEye('新增'); assert.equal(previews().length, 0)
  clickEye('undefined-key'); assert.equal(previews().length, 1)
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(previews().length, 0, 're-review clears preview')
  clickEye('undefined-key')
  const reviewed = latest
  for (const failure of [new Error('network failed'), { ok: false, error: { message: 'RPC failed' } }]) {
    latest = failure
    await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
    assert.equal(previews().length, 1, 'failed refresh preserves preview')
    assert.equal(eye('undefined-key').props['aria-expanded'], true)
    assert(walk(tree).some(n => n.children?.join('').includes('待应用快照：Full')))
    assert.equal(button(tree, '重新审阅最新版本').props.disabled, false)
    assertWarning(failure.message ?? failure.error.message)
  }
  latest = status('Polling')
  await timer(); tree = render()
  assert.equal(previews().length, 1, 'polling preserves pinned preview')
  assert(walk(tree).some(n => n.children?.join('').includes('待应用快照：Full')))
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  let resolveStatus
  pendingStatus = new Promise(resolve => { resolveStatus = resolve })
  const refresh = button(tree, '重新审阅最新版本').props.onClick()
  tree = render()
  assert.equal(button(tree, '重新审阅最新版本').props.disabled, true)
  assert.equal(previews().length, 1, 'pending refresh preserves preview')
  const callsDuringRefresh = statusCalls
  await timer()
  await button(tree, '重新审阅最新版本').props.onClick()
  assert.equal(statusCalls, callsDuringRefresh, 'inFlight guard rejects polling and repeated click')
  resolveStatus({ ok: true, value: reviewed }); await refresh; pendingStatus = null; tree = render()
  assert.equal(previews().length, 0)
  latest = { ...status('Missing'), candidate: null }
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  assert.equal(button(tree, '重新审阅最新版本').props.disabled, false, 'null candidate does not strand retry')
  latest = reviewed
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  clickEye('undefined-key')
  const backdrop = walk(tree).find(n => n.props.className === 'pf-root pf-backdrop')
  backdrop.props.onKeyDown({ key: 'Escape', stopPropagation() {} }); tree = render()
  assert(!walk(tree).some(n => n.props.role === 'dialog'))
  walk(tree).find(n => n.type === 'button').props.onClick(); await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(previews().length, 0, 'close and reopen clears preview')
  const reopened = walk(tree).find(n => n.props.className === 'pf-root pf-backdrop')
  const target = {}; reopened.props.onClick({ target, currentTarget: target }); tree = render()
  assert(!walk(tree).some(n => n.props.role === 'dialog'))
  // Failed initial load is not an empty review and remains retryable.
  latest = new Error('open failed')
  trigger().props.onClick(); await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  assert.equal(button(tree, '重新审阅最新版本').props.disabled, false)
  assert(walk(tree).some(n => n.children?.includes('尚未加载完整审阅；请重新审阅重试。')))
  assert(!walk(tree).some(n => n.children?.includes('无内容变化')))
  latest = reviewed
  await button(tree, '重新审阅最新版本').props.onClick(); tree = render()
  pendingStatus = new Promise(resolve => { resolveStatus = resolve })
  const lateRefresh = button(tree, '重新审阅最新版本').props.onClick()
  const beforeReopen = statusCalls
  button(tree, '关闭').props.onClick(); tree = render()
  trigger().props.onClick(); tree = render()
  assert.equal(statusCalls, beforeReopen, 'reopening queues behind old review')
  assert.equal(previews().length, 0)
  assert.equal(button(tree, '应用此版本').props.disabled, true)
  assert(!walk(tree).some(n => n.children?.join('').includes('待应用快照：Full')))
  pendingStatus = null
  resolveStatus({ ok: true, value: status('Late') }); await lateRefresh
  await new Promise(r => setImmediate(r)); tree = render()
  assert.equal(statusCalls, beforeReopen + 1, 'only the new opening fetches a fresh review')
  assert(walk(tree).some(n => n.children?.join('').includes('待应用快照：Full')))
  assert(!walk(tree).some(n => n.children?.join('').includes('待应用快照：Late')))
  clickEye('undefined-key')
  assert.equal(previews().length, 1)
  pendingStatus = new Promise(resolve => { resolveStatus = resolve })
  const unmountedRefresh = button(tree, '重新审阅最新版本').props.onClick()
  cleanups.forEach(cleanup => cleanup())
  const beforeUnmountResponse = JSON.stringify(cells.slice(0, 7))
  resolveStatus({ ok: true, value: status('Unmounted') }); await unmountedRefresh
  assert.equal(JSON.stringify(cells.slice(0, 7)), beforeUnmountResponse, 'cleanup rejects all late state/review/preview updates')
})

test('remote replacement queues review on the new remote and clears working after old request', async () => {
  let definition, component, cursor = 0, timer
  const cells = [], effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useCallback(callback) { return callback },
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useEffect(callback, deps) {
      const i = cursor++, previous = cells[i]
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        const record = cells[i] = { deps }
        effects.push(() => { previous?.cleanup?.(); record.cleanup = callback() })
      }
    },
  }
  const value = revision => ({ sessionId: 's', generation: 1, busy: false, baselineRequired: false, noticeState: 'none', active: { revision: 'A' }, candidate: { revision }, diff: { added: [], removed: [], changed: [] } })
  let resolveOld, oldCalls = 0, newCalls = 0
  const oldRemote = {
    async summary() { return { ok: true, value: value('OldSummary') } },
    status() { ++oldCalls; return new Promise(resolve => { resolveOld = resolve }) },
  }
  const newRemote = {
    async summary() { return { ok: true, value: value('NewSummary') } },
    async status(id) { assert.equal(id, 's'); ++newCalls; return { ok: true, value: value('NewReview') } },
  }
  const sandbox = { window: { __ModuleLoader__: { load(v) { definition = v } } }, setTimeout(callback) { timer = callback; return 1 }, clearTimeout() {}, console }
  const client = await sourceClient(react, sandbox)
  const ctx = { effect: fn => fn(), locale: { register() { return () => {} } }, remote: { promptFreeze: oldRemote, async $mount() { return () => {} } }, inject(_, cb) { cb(ctx) }, slots: { inject(_, cb) { cb() }, register(_, cb) { component = cb } } }
  await client.apply(ctx)
  let remote = oldRemote
  const render = () => { cursor = 0; const element = component({ sessionId: 's', promptFreezeRemote: remote }); return element.type(element.props) }
  const walk = node => [node, ...node.children?.flatMap(child => typeof child === 'object' ? walk(child) : []) ?? []]
  const button = label => walk(tree).find(n => n.type === 'button' && n.children.join('') === label)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  let tree = render(); effects.splice(0).forEach(effect => effect()); await flush(); tree = render()
  walk(tree).find(n => n.props.className === 'pf-trigger').props.onClick(); tree = render()
  assert.equal(oldCalls, 1)
  remote = newRemote; tree = render(); effects.splice(0).forEach(effect => effect())
  // The replacement effect invalidates the old request. User intent queues
  // behind it, but must retain the new render's remote, not the drain's remote.
  const queuedReview = button('重新审阅最新版本').props.onClick()
  tree = render()
  assert.equal(newCalls, 0)
  assert.equal(button('应用此版本').props.disabled, true)
  resolveOld({ ok: true, value: value('Obsolete') })
  await queuedReview; await flush(); tree = render()
  assert.equal(oldCalls, 1)
  assert.equal(newCalls, 1)
  assert.equal(button('重新审阅最新版本').props.disabled, false, 'working clears after replacement queue drains')
  assert.equal(button('应用此版本').props.disabled, false)
  assert(walk(tree).some(n => n.children?.join('').includes('待应用快照：NewReview')))
  assert(!walk(tree).some(n => n.children?.join('').includes('待应用快照：Obsolete')))
  await timer(); tree = render()
  assert.equal(newCalls, 1, 'replacement polling remains summary-only')
  const withSettings = (revision, override) => ({ ...value('NewReview'), autoApply: { settingsRevision: revision, override, thresholdTokens: 24000, defaultThresholdTokens: 24000, inputTokens: 100, eligible: true } })
  newRemote.summary = async () => ({ ok: true, value: withSettings(3, '24K') })
  await timer(); tree = render()
  let resolveSave
  newRemote.setAutoApply = () => new Promise(resolve => { resolveSave = resolve })
  walk(tree).find(n => n.type === 'input').props.onChange({ target: { value: '9K' } }); tree = render()
  const saving = walk(tree).find(n => n.type === 'input').props.onBlur(); tree = render()
  remote = { async summary() { return { ok: true, value: withSettings(0, '12K') } } }
  tree = render(); effects.splice(0).forEach(effect => effect()); tree = render()
  assert.equal(walk(tree).find(n => n.type === 'input').props.disabled, true, 'replacement clears old editor settings')
  resolveSave({ ok: true, value: withSettings(99, '99K') }); await saving
  await timer(); tree = render()
  assert.equal(walk(tree).find(n => n.type === 'input').props.value, '12K', 'old remote save cannot adopt obsolete settings')
  assert(!walk(tree).some(n => n.children?.includes('设置已保存；未应用快照。')))
  for (const cell of cells) cell?.cleanup?.()
})

test('built ModuleLoader client mounts matching strict RPC descriptors and session-scoped UI slot', async () => {
  let definition, registration, component, mounted
  const sandbox = { window: { __ModuleLoader__: { load(value) { definition = value } } }, setTimeout, clearTimeout, console }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const client = definition.factory(name => { assert(['react', 'react-dom'].includes(name)); return react })
  let localeRegistration
  const ctx = {
    effect: fn => fn(),
    locale: { register(ns, dictionaries) { localeRegistration = { ns, dictionaries }; return () => {} } },
    remote: { promptFreeze: {}, async $mount(value) { mounted = value; return async () => {} } },
    inject(keys, callback) { callback(ctx) },
    slots: { inject(name, callback) { assert.equal(name, 'conversation.input.left'); callback() }, register(options, render) { registration = options; component = render } }
  }
  await client.apply(ctx)
  assert.equal(definition.id, PACKAGE)
  // The bundle id, contract.PACKAGE and the manifest name are three copies of one identity.
  assert.equal(PACKAGE, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name, 'contract and manifest package names must agree')
  assert.equal(registration.name, 'conversation.input.left')
  assert.equal(registration.id, 'prompt-freeze')
  assert.equal(registration.locale, 'prompt-freeze')
  assert.equal(localeRegistration.ns, registration.locale)
  assert.deepEqual(Object.keys(localeRegistration.dictionaries).sort(), ['en', 'zh'])
  assert(Array.from(client.inject).includes('locale'))
  assert.equal(client.name, 'prompt-freeze/client')
  assert.equal(component({ sessionId: 'a' }).type.name, 'PromptFreezePanel')
  assert.equal(registration.inject().promptFreezeRemote, ctx.remote.promptFreeze)
  for (const descriptor of descriptors) {
    assert.equal(descriptor.service, 'promptFreeze')
    assert.equal(descriptor.namespace, 'promptFreeze')
    assert.equal(descriptor.id, `${PACKAGE}#promptFreeze/${descriptor.method}`)
  }
  assert.equal(component({ sessionId: 'a' }).props.key, 'a')
  assert.deepEqual(Array.from(mounted.descriptors, d => d.method), descriptors.map(d => d.method))
  // Standard Remote decorators register their markers during instance initialization.
  const hostContext = new Context()
  try {
    const host = new PromptFreeze(hostContext, { directory: join(tmpdir(), 'prompt-freeze-unused') })
    assert.deepEqual(remoteMethods(host).map(m => m.method).sort(), ['acknowledgeObservation', 'applySnapshot', 'keep', 'resolveRecovery', 'setAutoApply', 'status', 'summary'])
  } finally { await hostContext.fiber.dispose() }
  assert.throws(() => descriptors[1].parameters[2].codec.create().parse(-1))
  assert.throws(() => descriptors[1].parameters[3].codec.create().parse('yes'))
})
