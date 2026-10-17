import type { Unit, ChangeKind, DiffRow, ContentValue, Translator, FormattedValue, LineRow, LineDiff, ItemDiff } from './client-types.js'

import { standaloneTranslator } from './locales.js'
// Dependency-free display formatting and bounded line alignment. Never drops input lines.
const MAX_CELLS = 250000
const own = (value: unknown, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)
function formatValue(unit: Unit, raw: ContentValue | string | null | undefined, name: string, t: Translator = standaloneTranslator()): FormattedValue {
  if (raw == null || (raw as ContentValue).unavailable) return { unavailable: true, text: '' }
  if (unit === 'sections' || unit === 'contexts') {
    if (typeof raw === 'string') return { text: raw }
    return own(raw, 'text') && typeof raw.text === 'string' ? { text: raw.text } : { unavailable: true, text: '' }
  }
  const fields = unit === 'tools' ? ['name', 'description', 'parameters', 'deferLoading'] : ['defined', 'value']
  const annotations: string[] = []
  const value: Record<string, unknown> = {}
  for (const field of fields) {
    if (field === 'name' && !own(raw, field)) value.name = name
    else if (own(raw, field)) {
      if ((raw as ContentValue)[field] === undefined) annotations.push(t('undefinedField', { field }))
      else value[field] = (raw as ContentValue)[field]
    } else annotations.push(t('missingField', { field }))
  }
  if (unit === 'variables' && (raw as ContentValue).defined === false) annotations.push(t('undefinedVariable'))
  // Annotations stay outside JSON, so literal strings cannot masquerade as undefined/missing.
  return { text: JSON.stringify(value, null, 2) + (annotations.length ? '\n' + annotations.map(s => `// ${s}`).join('\n') : '') }
}
function lineDiff(before: string | null, after: string | null, maxCells: number = MAX_CELLS): LineDiff {
  const a = before === null ? [] : before.split('\n'), b = after === null ? [] : after.split('\n')
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const rows: LineRow[] = []; let oldLine = 0, newLine = 0
  const push = (kind: LineRow['kind'], text: string) => rows.push({ kind, text, oldLine: kind === '+' ? null : ++oldLine, newLine: kind === '-' ? null : ++newLine })
  for (let i = 0; i < prefix; i++) push(' ', a[i])
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix
  const fallback = n > 0 && m > 0 && (n + 1) * (m + 1) > Math.min(MAX_CELLS, Math.max(0, maxCells))
  if (fallback || !n || !m) {
    for (let i = 0; i < n; i++) push('-', a[prefix + i])
    for (let j = 0; j < m; j++) push('+', b[prefix + j])
  } else {
    const width = m + 1, table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = a[prefix + i] === b[prefix + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { push(' ', a[prefix + i++]); j++ }
      else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) push('-', a[prefix + i++])
      else push('+', b[prefix + j++])
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) push(' ', a[i])
  return { rows, fallback, oldCount: a.length, newCount: b.length }
}
function itemDiff(unit: Unit, kind: ChangeKind, row: DiffRow, t: Translator = standaloneTranslator()): ItemDiff {
  const before = kind === 'added' ? null : formatValue(unit, kind === 'changed' ? row.before : row, row.name, t)
  const after = kind === 'removed' ? null : formatValue(unit, kind === 'changed' ? row.after : row, row.name, t)
  const unavailable = [before?.unavailable && t('beforeUnavailable'), after?.unavailable && t('afterUnavailable')].filter(Boolean) as string[]
  // Do not turn an unknown side into an empty side and fabricate additions/deletions.
  if (unavailable.length) return { unavailable, knownBefore: before && !before.unavailable ? before.text : null, knownAfter: after && !after.unavailable ? after.text : null }
  return { ...lineDiff(before === null ? null : before.text, after === null ? null : after.text), unavailable: [], beforeAbsent: before === null, afterAbsent: after === null }
}
export { formatValue, lineDiff, itemDiff, MAX_CELLS }
