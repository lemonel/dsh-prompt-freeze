import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const flush = () => new Promise(resolve => setImmediate(resolve))
const walk = node => [node, ...(node.children ?? []).flatMap(child => typeof child === 'object' && child ? walk(child) : [])]
const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : String(node)
const empty = { added: [], removed: [], changed: [], orderChanged: false }
const workspaceChange = { ...empty, changed: [{ name: 'workspace', before: { name: 'workspace', text: '/a' }, after: { name: 'workspace', text: '/b' } }] }
const variableChange = { ...empty, added: [{ name: 'mode', defined: true, value: 'slow' }] }
const liveSectionRow = { name: 'harness:identity', live: true, before: { name: 'harness:identity', live: true, text: 'live A' }, after: { name: 'harness:identity', live: true, text: 'live B' } }
const frozenSectionRow = { name: 'tool:pipeline', live: false, before: { name: 'tool:pipeline', text: 'frozen A' }, after: { name: 'tool:pipeline', text: 'frozen B' } }

function view({ baselineRevision = 'baseline-observation', contexts = true, variables = true, liveSection = true, frozenSection = false, liveChanges = null } = {}) {
  const changed = [...liveSection ? [liveSectionRow] : [], ...frozenSection ? [frozenSectionRow] : []]
  return { sessionId: 's', generation: 1, busy: false, baselineRequired: false, noticeState: 'none', liveChanges,
    active: { revision: 'A' }, candidate: { revision: 'A' }, kept: null,
    diff: { added: [], removed: [], changed: [], sdkChanged: false, modeChanged: false },
    observation: { baseline: baselineRevision === null ? null : { revision: baselineRevision }, current: { revision: 'live' }, baselineAvailable: baselineRevision !== null,
      diff: { sections: { ...empty, changed }, tools: empty, contexts: contexts ? workspaceChange : empty, variables: variables ? variableChange : empty } } }
}

async function harness(language = 'zh') {
  let cursor = 0, component, tree, cells = [], effects = []
  const react = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) } },
    createPortal: node => node, useCallback: fn => fn,
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn) } },
  }
  const sandbox = { exports: {}, REMOTE: {}, require: name => ['react', 'react-dom'].includes(name) ? react : require('../lib/' + name),
    window: { addEventListener() {}, removeEventListener() {} }, setTimeout: () => 1, clearTimeout() {} }
  vm.runInNewContext(await readFile(new URL('../lib/client.cjs', import.meta.url), 'utf8'), sandbox)
  let latest = view(), answer, calls = []
  const remote = {
    async summary() { return { ok: true, value: latest } },
    async status() { return { ok: true, value: latest } },
    async acknowledgeObservation(...args) { calls.push(args); return answer ?? { ok: true, value: view({ baselineRevision: 'baseline-after', contexts: false, variables: false, liveSection: false, frozenSection: false, liveChanges: null }) } },
  }
  const ctx = { effect: fn => fn(), locale: { register() {} }, remote: { async $mount() {} }, inject(_, fn) { fn(ctx) }, slots: { inject(_, fn) { fn() }, register(_, fn) { component = fn } } }
  await sandbox.exports.apply(ctx)
  const t = require('../lib/locales.cjs').standaloneTranslator(language)
  const render = () => { cursor = 0; const node = component({ sessionId: 's', promptFreezeRemote: remote, t }); tree = node.type(node.props); effects.splice(0).forEach(fn => fn()); return tree }
  const buttons = () => walk(tree).filter(node => node.type === 'button')
  const button = label => buttons().find(node => node.children.join('') === label)
  const nav = () => walk(tree).find(node => node.props.className === 'pf-nav')
  const navEntry = unit => nav().children.find(node => text(node).startsWith(t(unit)))
  const trigger = () => walk(tree).find(node => node.props.className === 'pf-trigger')
  const openDialog = async () => { trigger().props.onClick(); await flush(); render() }
  const select = unit => { navEntry(unit).props.onClick(); render() }
  const sectionRows = () => walk(tree).filter(node => node.props.className === 'pf-item-header').map(text)
  render(); await flush(); render()
  return { render, t, button, buttons, nav, navEntry, trigger, openDialog, select, sectionRows, calls, get tree() { return tree }, set latest(value) { latest = value }, set answer(value) { answer = value } }
}

const openWith = async (language, options) => { const h = await harness(language); h.latest = view(options); h.render(); await flush(); h.render(); await h.openDialog(); return h }

for (const language of ['zh', 'en']) test(`live acknowledgement ${language}: one footer action for every live-tagged entry`, async () => {
  const h = await openWith(language, {})
  const ack = h.button(h.t('acknowledge'))
  assert(ack, 'the footer offers one acknowledgement for the live diagnostics')
  assert.equal(ack.props.title, h.t('acknowledgeHelp'))
  assert.equal(ack.props.disabled, false)
  // A single overall action beside Apply, independent of the reviewed category.
  const actions = walk(h.tree).find(node => node.props.className === 'pf-actions')
  assert(actions.children.includes(ack))
  assert(actions.children.includes(h.button(h.t('apply'))))
  // Live-tagged categories carry the discovery tag in the summary nav.
  for (const unit of ['sections', 'contexts', 'variables']) {
    assert(h.navEntry(unit).children.some(node => node.props?.className === 'pf-badge pf-live'), unit)
  }
  await h.select('tools')
  assert(h.button(h.t('acknowledge')), 'still offered while reviewing tools')
  h.button(h.t('acknowledge')).props.onClick()
  await flush(); h.render()
  assert.deepEqual(h.calls, [['s', 'baseline-observation']])
  assert.equal(h.button(h.t('acknowledge')), undefined, 'acknowledged diagnostics stop showing differences')
  for (const unit of ['sections', 'contexts', 'variables']) {
    assert(!h.navEntry(unit).children.some(node => node.props?.className === 'pf-badge pf-live'), unit)
    assert(text(h.navEntry(unit)).includes(h.t('groupCount', { label: h.t('changed'), count: 0 })), unit)
  }
})

test('a frozen-only section difference never offers the live acknowledgement', async () => {
  const h = await openWith('zh', { contexts: false, variables: false, liveSection: false, frozenSection: true })
  assert.equal(h.button(h.t('acknowledge')), undefined, 'frozen differences need Apply')
  assert(!h.navEntry('sections').children.some(node => node.props?.className === 'pf-badge pf-live'))
  h.select('sections')
  assert(h.sectionRows().some(row => row.includes('tool:pipeline')), 'the frozen difference stays visible')
})

test('acknowledging keeps frozen section rows while clearing live ones', async () => {
  const h = await openWith('zh', { liveSection: true, frozenSection: true })
  h.select('sections')
  assert(h.sectionRows().some(row => row.includes('harness:identity')) && h.sectionRows().some(row => row.includes('tool:pipeline')))
  h.button(h.t('acknowledge')).props.onClick()
  await flush(); h.render()
  assert(h.sectionRows().some(row => row.includes('tool:pipeline')), 'the frozen row still needs Apply')
  assert(!h.sectionRows().some(row => row.includes('harness:identity')), 'the live row is acknowledged')
  assert(!h.navEntry('sections').children.some(node => node.props?.className === 'pf-badge pf-live'))
})

test('compact summary live tags reach the entry tooltip', async () => {
  const h = await harness('zh')
  const liveChanges = { sections: { count: 1, names: ['harness:identity'] }, variables: { count: 2, names: ['a', 'b'] } }
  h.latest = view({ liveChanges }); h.render(); await flush(); h.render()
  await h.openDialog()
  const summary = h.t('liveSummary', { units: `${h.t('sections')} 1 · ${h.t('variables')} 2` })
  assert(h.trigger().props.title.includes(summary))
  assert(h.trigger().props['aria-label'].includes(summary))
  // A fresh review without live tags clears the entry tag again.
  h.latest = view(); h.button(h.t('review')).props.onClick(); await flush(); h.render()
  assert(!h.trigger().props.title.includes(h.t('liveSummary', { units: h.t('sections') })))
  assert(h.trigger().props.title.includes('Prompt Freeze'))
})

test('acknowledgement is hidden when no observation baseline exists', async () => {
  const h = await harness('zh')
  h.latest = view({ baselineRevision: null })
  h.render(); await flush(); h.render()
  await h.openDialog()
  assert.equal(h.button(h.t('acknowledge')), undefined)
  assert(h.nav().children.map(text).some(entry => entry.includes(h.t('missingBaseline'))), 'unavailable diagnostics are labelled as such')
})

test('a rejected acknowledgement surfaces the error and keeps the diagnostics', async () => {
  const h = await openWith('zh', {})
  const message = 'Stale observation baseline: refresh and review the current diagnostics again'
  h.answer = { ok: false, error: { message } }
  h.button(h.t('acknowledge')).props.onClick()
  await flush(); h.render()
  const banner = walk(h.tree).find(node => node.props.className?.includes('pf-live-status'))
  assert(banner, 'the shared live status banner reports the failure')
  assert(text(banner).includes(message))
  assert(h.button(h.t('acknowledge')), 'unacknowledged diagnostics remain visible')
  assert.deepEqual(h.calls, [['s', 'baseline-observation']])
})
