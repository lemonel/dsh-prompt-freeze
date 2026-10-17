import * as React from 'react'
import type { ReactNode, ReactElement } from 'react'
import type { Unit, ChangeKind, DiffRow, ContentValue, Translator, DisplayDelta, PanelState, RecoveryOutcome } from './client-types.js'
import { itemDiff } from './diff.js'

const { createElement: h } = React
export const categories: Unit[] = ['tools', 'sections', 'contexts', 'variables']
export const changeKinds: ChangeKind[] = ['added', 'removed', 'changed']

export const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
export const formatTokens = (value: number): string => value >= 1e6 ? `${+(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${+(value / 1e3).toFixed(1)}K` : String(Math.round(value))
export function recoveryUsageView(outcome: RecoveryOutcome, t: Translator): ReactElement | null {
  if (!outcome.usageStatus || outcome.usageStatus === 'pending') return null
  if (outcome.usageStatus === 'not-called') return h('div', null, t('usageNotCalled'))
  const usage = outcome.usage
  if (outcome.usageStatus !== 'reported' || !usage || !tokenCount(usage.inputTokens)) return h('div', null, t('usageUnavailable'))
  return h('div', null,
    h('div', null, t('usageInput', { input: formatTokens(usage.inputTokens), cached: tokenCount(usage.cacheReadTokens) ? formatTokens(usage.cacheReadTokens) : t('usageCounterUnavailable') })),
    tokenCount(usage.cacheWriteTokens) && h('div', null, t('usageCacheWrite', { tokens: formatTokens(usage.cacheWriteTokens) })))
}
const fieldsFor = (unit: Unit): string[] => unit === 'tools' ? ['description', 'parameters', 'deferLoading'] : unit === 'variables' ? ['defined', 'value'] : ['text']
const content = (value: ContentValue | string | undefined, unit: Unit): ContentValue => typeof value === 'string' && unit !== 'tools' && unit !== 'variables' ? { text: value } : value as ContentValue ?? {}
export function categoryDelta(shown: PanelState | null, unit: Unit): DisplayDelta {
  const complete = shown?.observation?.baselineAvailable && shown.observation.diff?.[unit]
  const source = complete || (unit === 'tools' ? shown?.diff : unit === 'sections' ? shown?.diff?.sections : null)
  if (!source) return { available: false, partial: !complete }
  const resolve = (row: DiffRow | string, side: 'active' | 'candidate'): DiffRow => typeof row !== 'string' ? row : (shown?.[side]?.callables ?? shown?.[side]?.tools ?? []).find(item => item.name === row) ?? { name: row, unavailable: true }
  return { ...source, available: true, partial: !complete,
    beforeOrder: source.beforeOrder ?? (shown?.active?.tools ?? []).map(row => row.name),
    afterOrder: source.afterOrder ?? (shown?.candidate?.tools ?? []).map(row => row.name),
    added: (source.added ?? []).map(row => resolve(row, 'candidate')),
    removed: (source.removed ?? []).map(row => resolve(row, 'active')),
    changed: (source.changed ?? []).filter(row => fieldsFor(unit).some(field => JSON.stringify(content(row.before, unit)[field]) !== JSON.stringify(content(row.after, unit)[field]))) }
}
export const counts = (delta: DisplayDelta, t: Translator): ReactNode => delta.available ? changeKinds.flatMap((kind, index) => [
  ...(index ? [' · '] : []),
  h('span', { key: kind, className: `pf-count pf-count-${kind}` }, t('groupCount', { label: t(kind), count: delta[kind].length })),
]) : t('unavailable')
function eye(name: string, id: string, expanded: boolean, toggle: () => void, t: Translator): ReactElement {
  return h('button', { type: 'button', className: 'pf-eye', 'aria-label': t('viewDiff', { name }), title: t('viewDiff', { name }), 'aria-expanded': expanded, 'aria-controls': id, onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); toggle() } }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true, focusable: false }, h('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }), h('circle', { cx: 12, cy: 12, r: 3 })))
}
function diffView(unit: Unit, kind: ChangeKind, row: DiffRow, t: Translator): ReactElement {
  const diff = itemDiff(unit, kind, row, t)
  return h('section', { className: 'pf-diff', key: row.name, 'aria-label': t('unifiedDiff', { name: row.name }) },
    h('div', { className: 'pf-diff-head' }, h('strong', null, row.name), h('div', null, `--- ${kind === 'added' ? '/dev/null' : 'a/' + row.name}`), h('div', null, `+++ ${kind === 'removed' ? '/dev/null' : 'b/' + row.name}`)),
    'knownBefore' in diff ? [diff.unavailable.map(text => h('p', { className: 'pf-warning', key: text }, text)), diff.knownBefore !== null && h('pre', null, t('knownBefore'), diff.knownBefore || t('emptyString')), diff.knownAfter !== null && h('pre', null, t('knownAfter'), diff.knownAfter || t('emptyString'))] : [
      diff.fallback && h('p', { className: 'pf-note' }, t('largeDiff')),
      h('div', { className: 'pf-diff-head' }, `@@ -${diff.oldCount ? 1 : 0},${diff.oldCount} +${diff.newCount ? 1 : 0},${diff.newCount} @@ · ${t('lineNumbers')}`),
      h('div', { className: 'pf-diff-lines' }, diff.rows.map((line, index) => h('div', { className: `pf-diff-line${line.kind === '+' ? ' pf-diff-add' : line.kind === '-' ? ' pf-diff-remove' : ''}`, key: index }, h('span', { className: 'pf-diff-num' }, line.oldLine ?? ''), h('span', { className: 'pf-diff-num' }, line.newLine ?? ''), h('span', null, line.kind), h('span', null, line.text || t('emptyLine')))))])
}
export function detailView(unit: Unit, delta: DisplayDelta, preview: string | null, setPreview: (value: string | null) => void, panelId: string, t: Translator): ReactElement {
  if (!delta.available) return h('p', null, t('noBaseline'))
  const rows = ([['added', t('added')], ['removed', t('removed')], ['changed', t('changed')]] as Array<[ChangeKind, string]>).filter(([kind]) => delta[kind].length).map(([kind, label]) => {
    const groupKey = JSON.stringify([unit, kind]), groupId = `${panelId}-${kind}-group`, groupOpen = preview === groupKey
    return h('section', { className: 'pf-group', key: kind }, h('h4', null, t('groupCount', { label, count: delta[kind].length }), eye(label, groupId, groupOpen, () => setPreview(groupOpen ? null : groupKey), t)),
      h('div', { id: groupId, hidden: !groupOpen }, groupOpen && delta[kind].map(row => diffView(unit, kind, row, t))),
      delta[kind].map((row, index) => {
        const key = JSON.stringify([unit, kind, row.name]), id = `${panelId}-${kind}-${index}`, expanded = preview === key
        return h('div', { key, className: 'pf-item' },
          h('div', { className: 'pf-item-header' }, h('span', { className: 'pf-badge' }, label), h('span', null, row.name), (unit === 'contexts' || unit === 'variables' || row.live || (row.before as ContentValue)?.live || (row.after as ContentValue)?.live) && h('span', { className: 'pf-badge', title: t('liveCacheHelp') }, t('live')), eye(row.name, id, expanded, () => setPreview(expanded ? null : key), t)),
          h('div', { id, hidden: !expanded }, expanded && diffView(unit, kind, row, t)))
      }))
  })
  return h('div', null, h('p', { className: 'pf-counts' }, counts(delta, t)), h('p', { className: 'pf-note' }, t('diffHelp')), rows.length ? rows : h('p', null, t('noChanges')),
    h('details', { className: 'pf-item' }, h('summary', null, t('orderChanged', { changed: delta.orderChanged ? t('yes') : t('no') })), h('div', { className: 'pf-values' }, h('p', null, t('beforeOrder', { order: (delta.beforeOrder ?? []).join(' → ') || t('emptyOrder') })), h('p', null, t('afterOrder', { order: (delta.afterOrder ?? []).join(' → ') || t('emptyOrder') })))))
}
