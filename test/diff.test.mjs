import test from 'node:test'
import assert from 'node:assert/strict'
import diff from '../lib/diff.cjs'
const { lineDiff, formatValue, itemDiff, MAX_CELLS } = diff

test('bounded line alignment keeps stable context and accurate old/new numbers', () => {
  const result = lineDiff('head\nold\ncontext\ntail', 'head\nnew\ncontext\ntail')
  assert.equal(result.fallback, false)
  assert.deepEqual(result.rows, [
    { kind: ' ', text: 'head', oldLine: 1, newLine: 1 },
    { kind: '-', text: 'old', oldLine: 2, newLine: null },
    { kind: '+', text: 'new', oldLine: null, newLine: 2 },
    { kind: ' ', text: 'context', oldLine: 3, newLine: 3 },
    { kind: ' ', text: 'tail', oldLine: 4, newLine: 4 }
  ])
  assert(lineDiff('same\n', 'same\n').rows.every(row => row.kind === ' '))
  assert.deepEqual(lineDiff(null, '').rows, [{ kind: '+', text: '', oldLine: null, newLine: 1 }])
  assert.deepEqual(lineDiff('', null).rows, [{ kind: '-', text: '', oldLine: 1, newLine: null }])
  assert.equal(lineDiff(null, null).rows.length, 0)
})

test('large diff bounds quadratic work and preserves every remaining line', () => {
  const a = ['head', ...Array.from({ length: 3000 }, (_, i) => `old-${i}`), 'tail'].join('\n')
  const b = ['head', ...Array.from({ length: 3000 }, (_, i) => `new-${i}`), 'tail'].join('\n')
  const result = lineDiff(a, b)
  assert.equal(MAX_CELLS, 250000)
  assert.equal(result.fallback, true)
  assert.equal(result.rows.length, 6002)
  assert.equal(result.rows.filter(r => r.kind !== '+').map(r => r.text).join('\n'), a)
  assert.equal(result.rows.filter(r => r.kind !== '-').map(r => r.text).join('\n'), b)
  assert.equal(result.rows.at(-1).oldLine, 3002)
})

test('typed formatting preserves raw text, JSON and missing/undefined/empty distinctions', () => {
  assert.equal(formatValue('contexts', { text: 'a\n\nb\n' }).text, 'a\n\nb\n')
  assert.equal(formatValue('sections', '').text, '')
  assert.equal(formatValue('sections', {}).unavailable, true)
  const tool = formatValue('tools', { description: 'desc', parameters: { type: 'object' }, deferLoading: false }, 'tool')
  assert.deepEqual(JSON.parse(tool.text), { name: 'tool', description: 'desc', parameters: { type: 'object' }, deferLoading: false })
  const missing = formatValue('variables', { defined: true }).text
  const undef = formatValue('variables', { defined: true, value: undefined }).text
  const empty = formatValue('variables', { defined: true, value: '' }).text
  assert.notEqual(missing, undef); assert.notEqual(undef, empty)
  assert.match(missing, /字段缺失/); assert.match(undef, /undefined（字段存在）/)
  assert.match(formatValue('variables', { defined: false }).text, /key 存在/)
  assert.equal(itemDiff('sections', 'added', { name: 'empty', text: '' }).rows[0].kind, '+')
  assert.equal(itemDiff('sections', 'removed', { name: 'empty', text: '' }).rows[0].kind, '-')
  const unknown = itemDiff('tools', 'changed', { name: 'old', before: { unavailable: true }, after: { description: 'new' } })
  assert.equal(unknown.rows, undefined); assert.match(unknown.unavailable[0], /之前数据不可用/)
  assert.match(unknown.knownAfter, /new/)
})
