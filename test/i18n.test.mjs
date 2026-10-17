import test from 'node:test'
import assert from 'node:assert/strict'
import { frontendModules } from './frontend-module.mjs'
import locales from '../lib/locales.cjs'
import diff from '../lib/diff.cjs'
const { dictionaries, standaloneTranslator } = locales

test('locale keys and interpolation parameters match; unknown standalone locale falls back to English', () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  const params = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  for (const key of Object.keys(dictionaries.en)) {
    assert.deepEqual(params(dictionaries.zh[key]), params(dictionaries.en[key]), key)
    assert(dictionaries.zh[key] && dictionaries.en[key], key)
  }
  assert.equal(standaloneTranslator('unknown')('close'), 'Close')
  for (const language of ['zh', 'en']) {
    const t = standaloneTranslator(language)
    assert.equal(t('counts', { added: 2, removed: 3, changed: 4 }), language === 'zh' ? '新增 2 个 · 删除 3 个 · 修改 4 个' : 'Added 2 · Removed 3 · Changed 4')
    assert.equal(t('viewDiff', { name: '原始{name}<tool>' }), language === 'zh' ? '查看原始{name}<tool>差异' : 'View differences for 原始{name}<tool>')
  }
})

test('count segments keep localized labels, zeroes, neutral unavailable text and theme-aware wrapping', async () => {
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const load = frontendModules(react)
  const { counts } = load('./display.cjs')
  const { css } = load('./styles.cjs')
  for (const language of ['zh', 'en']) {
    const t = standaloneTranslator(language)
    for (const lengths of [[0, 0, 0], [2, 0, 14]]) {
      const kinds = ['added', 'removed', 'changed']
      const delta = { available: true, ...Object.fromEntries(kinds.map((kind, i) => [kind, Array(lengths[i])])) }
      const parts = counts(delta, t)
      const segments = parts.filter(part => typeof part === 'object')
      assert.equal(segments.length, 3)
      segments.forEach((segment, i) => {
        assert.equal(segment.type, 'span')
        assert.equal(segment.props.className, `pf-count pf-count-${kinds[i]}`)
        assert.equal(segment.props['aria-hidden'], undefined, 'labels and numbers remain accessible')
        assert.equal(segment.children.join(''), t('groupCount', { label: t(kinds[i]), count: lengths[i] }))
      })
      assert.equal(parts.map(part => typeof part === 'object' ? part.children.join('') : part).join(''), t('counts', Object.fromEntries(kinds.map((kind, i) => [kind, lengths[i]]))))
    }
    assert.equal(counts({ available: false }, t), t('unavailable'))
  }
  assert.match(css, /\.pf-counts \{[^}]*white-space:normal;/)
  assert.doesNotMatch(css.match(/\.pf-counts \{[^}]*\}/)[0], /opacity/)
  assert.match(css, /\.pf-count \{[^}]*display:inline-block;[^}]*white-space:nowrap;/)
  for (const [kind, light, dark] of [['added', '#00852f', '#22c55e'], ['removed', '#e02030', '#ff4d5e'], ['changed', '#996e00', '#facc15']]) {
    assert(css.includes(`.pf-count-${kind} { color:light-dark(${light},${dark}); }`))
    const luminance = hex => {
      const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    assert((1.05 / (luminance(light) + 0.05)) >= 4.5, `${kind} on white`)
    assert(((luminance(dark) + 0.05) / (luminance('#222222') + 0.05)) >= 4.5, `${kind} on dark`)
  }
})

test('diff translations affect annotations only; raw tool schemas, sections, contexts and variables are unchanged', () => {
  const raw = '原始 text {name}\n关闭 Close\n'
  for (const language of ['zh', 'en']) {
    const t = standaloneTranslator(language)
    for (const unit of ['sections', 'contexts']) {
      assert.equal(diff.formatValue(unit, { text: raw }, '原名', t).text, raw)
      assert.deepEqual(diff.itemDiff(unit, 'added', { name: '原名', text: raw }, t).rows.map(r => r.text), raw.split('\n'))
    }
    const tool = { name: '原名', description: raw, parameters: { type: 'object', properties: { 原始: { description: raw } } }, deferLoading: false }
    assert.deepEqual(JSON.parse(diff.formatValue('tools', tool, tool.name, t).text), tool)
    assert.deepEqual(JSON.parse(diff.formatValue('variables', { defined: true, value: raw }, '原名', t).text), { defined: true, value: raw })
    assert(diff.formatValue('variables', { defined: false }, '原名', t).text.includes(t('undefinedVariable')))
    assert.equal(diff.itemDiff('tools', 'removed', { name: '原名', unavailable: true }, t).unavailable[0], t('beforeUnavailable'))
  }
})

test('same pinned panel reacts to injected t without requests or resetting review and preview', async () => {
  const empty = { added: [], removed: [], changed: [], beforeOrder: [], afterOrder: [] }
  const rawName = '原始{name}', rawValue = '关闭 Close {value}'
  const delta = { ...empty, added: [{ name: rawName, defined: false }], removed: [{ name: 'old', defined: true, value: rawValue }], changed: [{ name: 'changed', before: { defined: true, value: 'before' }, after: { defined: true, value: rawValue } }] }
  const review = { active: { revision: 'a' }, candidate: { revision: 'b' }, generation: 1, noticeState: 'pending', autoApply: { thresholdTokens: 2000000, inputTokens: 12500, eligible: true }, observation: { baselineAvailable: true, diff: { variables: delta } } }
  const cells = [review, '', true, false, review, 'variables', JSON.stringify(['variables', 'removed']), { draft: '2M', baseRevision: 4, dirty: true, conflict: true, pending: false, error: '', result: false }, { open: false, pending: false, error: '' }, null, { left: 8, top: 8 }]
  let cursor = 0, effects = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(x => x !== false && x != null) }),
    useState: () => { const i = cursor++; return [cells[i], v => { cells[i] = v }] },
    useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: () => { effects++ },
  }
  const { PromptFreezePanel } = frontendModules(react)('./panel.cjs')
  const walk = node => typeof node !== 'object' ? [] : [node, ...node.children.flatMap(walk)]
  const render = language => { cursor = 0; return PromptFreezePanel({ sessionId: 's', promptFreezeRemote: {}, t: standaloneTranslator(language) }) }
  const original = JSON.stringify(cells)
  for (const language of ['zh', 'en', 'zh']) {
    const t = standaloneTranslator(language), nodes = walk(render(language))
    assert(nodes.some(n => n.type === 'button' && n.children.includes(t('close'))))
    const text = node => typeof node === 'object' ? node.children.map(text).join('') : String(node)
    const summaries = nodes.filter(n => n.props.className === 'pf-counts')
    assert.equal(summaries.filter(n => text(n) === t('counts', { added: 1, removed: 1, changed: 1 })).length, 2, 'sidebar and detail share localized segments')
    assert.equal(summaries.filter(n => text(n) === t('unavailable')).length, 3)
    const nav = nodes.find(n => n.props.className === 'pf-nav')
    const selected = nav.children.find(n => n.props['aria-expanded'])
    assert.equal(selected.props['aria-controls'], 'pf-detail-s')
    assert(text(selected).includes(t('counts', { added: 1, removed: 1, changed: 1 })), 'button accessible text retains all counts')
    assert(nodes.some(n => n.props['aria-label'] === t('viewDiff', { name: rawName })))
    assert(nodes.some(n => n.props['aria-label'] === t('unifiedDiff', { name: 'old' })))
    assert(nodes.some(n => n.children.includes('  "value": "' + rawValue + '"')))
    assert(nodes.some(n => n.children.includes(t('live'))))
    const trigger = nodes.find(n => n.props.className === 'pf-trigger')
    assert(!trigger.props.title.includes('12.5K'))
    assert(!nodes.some(n => n.props.className === 'pf-input'))
    assert(trigger.props['aria-label'].includes(t('autoPending')))
    const input = nodes.find(n => n.type === 'input')
    assert.equal(input.props.title, undefined, 'threshold explanation is visible, not hidden in a hover tooltip')
    assert.equal(input.props['aria-label'], t('settingsThreshold'))
    for (const key of ['settingsThreshold', 'settingsHint', 'settingsConflict']) assert(nodes.some(n => n.children.includes(t(key))), key)
    for (const key of ['settingsSave', 'settingsUseDefault', 'settingsReload']) assert(!nodes.some(n => n.children.includes(t(key))), key)
    assert.equal(input.props.value, '2M')
    assert(nodes.some(n => n.type === 'label' && n.props.htmlFor === input.props.id))
    assert(nodes.some(n => n.props.id === input.props['aria-describedby'] && n.props.className === 'pf-threshold-hint' && n.children.includes(t('settingsHint'))))
    assert.equal(JSON.stringify(cells), original, 'language does not alter pinned data or preview')
    const visible = nodes.flatMap(n => n.children.filter(c => typeof c === 'string')).filter(c => !c.includes('.pf-root'))
    if (language === 'en') assert(!visible.some(c => /[\u4e00-\u9fff]/.test(c) && !c.includes('原始') && !c.includes('关闭 Close')), visible.join('\n'))
  }
  assert.equal(effects, 6, 'render leaves polling and toast positioning effect scheduling to React; no locale effect or refetch added')
})
