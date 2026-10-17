import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
const root = new URL('./', import.meta.url)
// The bundle id has to agree with the published package name.
const { name } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
await mkdir(new URL('lib/', root), { recursive: true })
const isFrontend = entry => entry === 'frontend_index.ts' || entry.startsWith('frontend/')
async function sourceNames(directory = '') {
  const entries = await readdir(new URL(`src/${directory}`, root), { withFileTypes: true })
  const sources = await Promise.all(entries.map(entry => {
    const name = `${directory}${entry.name}`
    if (entry.isDirectory()) return sourceNames(`${name}/`)
    return entry.isFile() && name.endsWith('.ts') && !name.endsWith('.d.ts') ? [name] : []
  }))
  return sources.flat().sort()
}
const sources = await sourceNames()
const entryOutputs = { 'backend_index.ts': 'index.mjs', 'frontend_index.ts': 'frontend_index.cjs' }
const outputName = entry => entryOutputs[entry] ?? posix.basename(entry).replace(/\.ts$/, isFrontend(entry) ? '.cjs' : '.mjs')
const outputs = new Map(sources.map(entry => [entry.replace(/\.ts$/, '.js'), outputName(entry)]))
if (new Set(outputs.values()).size !== sources.length) throw new Error('Runtime sources must have unique flat output names')
function rewriteSpecifiers(text, entry) {
  const file = ts.createSourceFile(entry.replace(/\.ts$/, '.js'), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits = []
  const visit = node => {
    let literal
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) literal = node.arguments[0]
    if (literal && ts.isStringLiteral(literal) && /^\.\.?\//.test(literal.text)) {
      const output = outputs.get(posix.normalize(posix.join(posix.dirname(entry), literal.text)))
      if (output) {
        const relative = posix.relative(posix.dirname(outputName(entry)), output)
        edits.push({ start: literal.getStart(file) + 1, end: literal.end - 1, text: relative.startsWith('.') ? relative : `./${relative}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return text
}
function compile(source, entry, module) {
  const compiled = ts.transpileModule(source, {
    fileName: entry,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module, useDefineForClassFields: false },
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => fileURLToPath(root), getNewLine: () => '\n' }))
  return rewriteSpecifiers(compiled.outputText, entry)
}
// Keep individually compiled modules for artifact checks and direct helper tests.
const commonJS = new Map()
for (const entry of sources) {
  const source = await readFile(new URL(`src/${entry}`, root), 'utf8')
  const cjs = compile(source, entry, ts.ModuleKind.CommonJS)
  commonJS.set(outputName(entry), cjs)
  const compiled = isFrontend(entry) ? cjs : compile(source, entry, ts.ModuleKind.ESNext)
  await writeFile(new URL(`lib/${outputName(entry)}`, root), `// Generated from src/${entry}; edit the TypeScript source instead.\n${compiled}`)
}
// Follow emitted require calls instead of assuming a fixed set of frontend helpers.
const bundled = new Map()
const externals = new Set(['react', 'react-dom'])
function collect(id) {
  if (bundled.has(id)) return
  const source = commonJS.get(id)
  if (source === undefined) throw new Error(`Missing browser module: ${id}`)
  bundled.set(id, source)
  const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const literal = node.arguments[0]
      if (!literal || !ts.isStringLiteral(literal)) throw new Error(`Non-literal browser require in ${id}`)
      if (/^\.\.?\//.test(literal.text)) collect(posix.normalize(posix.join(posix.dirname(id), literal.text)))
      else if (!externals.has(literal.text)) throw new Error(`Unsupported browser external ${literal.text} in ${id}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
const entryId = outputName('frontend_index.ts')
collect(entryId)
const definitions = [...bundled].map(([id, source]) => `${JSON.stringify(id)}: (module, exports, require) => {\n${source}\n}`).join(',\n')
const loader = `const __promptFreezeModules = {\n${definitions}\n};
const __promptFreezeCache = Object.create(null);
const __promptFreezeLoad = (id) => {
  if (__promptFreezeCache[id]) return __promptFreezeCache[id].exports;
  const factory = __promptFreezeModules[id];
  if (!factory) throw new Error('Missing bundled module: ' + id);
  const module = { exports: {} };
  __promptFreezeCache[id] = module;
  factory(module, module.exports, specifier => {
    if (specifier === 'react' || specifier === 'react-dom') return require(specifier);
    if (!/^\\.\\.?\\//.test(specifier)) throw new Error('Unsupported browser external: ' + specifier);
    const parts = id.split('/').slice(0, -1);
    for (const part of specifier.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.' && part !== '') parts.push(part);
    }
    return __promptFreezeLoad(parts.join('/'));
  });
  return module.exports;
};
Object.assign(exports, __promptFreezeLoad(${JSON.stringify(entryId)}));\n`
await writeFile(new URL('lib/client.cjs', root), `// Generated frontend bundle; edit src/ instead.\n${loader}`)
const contract = (await readFile(new URL('lib/contract.mjs', root), 'utf8')).replaceAll('export ', '')
await writeFile(new URL('lib/client.js', root), `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { const module = { exports: {} }; const exports = module.exports;\n${contract}\nconst REMOTE = remote;\n${loader}\nreturn module.exports; } });\n`)
await writeFile(new URL('lib/typert.host.mjs', root), "import { PACKAGE, descriptors } from './contract.mjs'\nexport const TYPERT = { package: PACKAGE, face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } }\n")
await writeFile(new URL('lib/typert.remote-client.mjs', root), "export { remote as default, remote as TYPERT_REMOTE } from './contract.mjs'\n")
console.error('Built runtime modules, ModuleLoader UI and Typert descriptors:', fileURLToPath(new URL('lib/', root)))
