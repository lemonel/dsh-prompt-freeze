// Static render of the actual component, without RPC or a running DSH instance.
// Usage: node test/ui-preview.mjs [output.html] [tools|sections|contexts|variables] [added|removed|changed] [item-name] [zh|en] (or set LANG_UI=en)
import { frontendModules } from './frontend-module.mjs'
import locales from '../lib/locales.cjs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const empty = { added: [], removed: [], changed: [], orderChanged: false }
const value = { active: { revision: 'baseline-123' }, candidate: { revision: 'candidate-456' }, generation: 1, noticeState: 'none', diff: empty, liveChanges: { sections: { count: 1, names: ['harness:identity'] }, contexts: { count: 1, names: ['runtime'] }, variables: { count: 2, names: ['unset', 'previous'] } }, observation: { baseline: { revision: 'baseline-observation' }, baselineAvailable: true, diff: {
  tools: { ...empty, added: [{ name: 'tool_search', description: 'Search available tools', parameters: { type: 'object', properties: { query: { type: 'string' } } }, deferLoading: true }], changed: [{ name: 'read_many', before: { description: 'Read files', parameters: { type: 'object' } }, after: { description: 'Read multiple file windows', parameters: { type: 'object', properties: { paths: { type: 'array' } } } } }] },
  sections: { ...empty, added: [{ name: 'tool:pipeline', text: 'Prefer sequential tool pipelines when all arguments are known upfront.' }], changed: [{ name: 'harness:identity', before: { text: 'Previous runtime', live: true }, after: { text: 'Current runtime', live: true } }] },
  contexts: { ...empty, added: [{ name: 'runtime', text: 'Current working directory: /workspace' }] },
  variables: { ...empty, added: [{ name: 'unset', defined: false }], removed: [{ name: 'previous', defined: true, value: 'old' }] }
} } }
let index = 0
const unit = process.argv[3] || 'tools'
const preview = process.argv[4] ? JSON.stringify([unit, process.argv[4], ...(process.argv[5] ? [process.argv[5]] : [])]) : null
// Live state is compact; only the explicitly loaded review contains details.
const { diff: _diff, observation: _observation, ...summary } = value
const cells = [summary, '', true, false, value, unit, preview,
  { draft: '', baseRevision: null, dirty: false, conflict: false, pending: false, error: '', result: false },
  { open: false, pending: false, error: '' }, null, { left: 8, top: 8 }]
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: () => [cells[index++], () => {}], useRef: initial => ({ current: initial }), useEffect() {}, useCallback(callback) { return callback } }
const { PromptFreezePanel } = frontendModules(react)('./panel.cjs')
const tree = PromptFreezePanel({ sessionId: 'preview', promptFreezeRemote: {}, t: locales.standaloneTranslator(process.env.LANG_UI || process.argv[6] || 'zh') })
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
function html(node) {
  if (node == null || node === false) return ''
  if (typeof node !== 'object') return escape(node)
  const attrs = Object.entries(node.props).filter(([k, v]) => !['ref', 'key'].includes(k) && !k.startsWith('on') && v != null && (v !== false || k.startsWith('aria-'))).map(([k, v]) => {
    const name = k === 'className' ? 'class' : k === 'strokeWidth' ? 'stroke-width' : k
    const value = k === 'style' ? Object.entries(v).map(([key, value]) => `${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${value}`).join(';') : v
    return ` ${name}="${escape(value)}"`
  }).join('')
  return `<${node.type}${attrs}${node.type === 'details' ? ' open' : ''}>${node.type === 'style' ? node.children.join('') : node.children.map(html).join('')}</${node.type}>`
}
await writeFile(process.argv[2] || join(tmpdir(), 'pf-preview.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;color-scheme:dark;background:#17191d;--dsw-alias-bg-layer-1:#24272d;--dsw-alias-label-primary:#eee">${html(tree)}</body>`)
