import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import ts from 'typescript'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const isFrontend = name => name === 'frontend_index.ts' || name.startsWith('frontend/')
async function sourceFiles(directory = '') {
  const entries = await readdir(new URL(`src/${directory}`, root), { withFileTypes: true })
  const names = await Promise.all(entries.map(entry => {
    const name = `${directory}${entry.name}`
    if (entry.isDirectory()) return sourceFiles(`${name}/`)
    return entry.isFile() ? [name] : []
  }))
  return names.flat().sort()
}
const sourceNames = async () => (await sourceFiles()).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
const entryOutputs = { 'backend_index.ts': 'index.mjs', 'frontend_index.ts': 'frontend_index.cjs' }
const outputName = name => entryOutputs[name] ?? posix.basename(name).replace(/\.ts$/, isFrontend(name) ? '.cjs' : '.mjs')

// Apply the same source-to-artifact mapping to module specifiers, never arbitrary strings.
function rewriteSpecifiers(text, name, sources) {
  const outputs = new Map(sources.map(source => [source.replace(/\.ts$/, '.js'), outputName(source)]))
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits = []
  const visit = node => {
    let literal
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) literal = node.arguments[0]
    if (literal && ts.isStringLiteral(literal) && /^\.\.?\//.test(literal.text)) {
      const output = outputs.get(posix.normalize(posix.join(posix.dirname(name), literal.text)))
      if (output) {
        const relative = posix.relative(posix.dirname(outputName(name)), output)
        edits.push({ start: literal.getStart(file) + 1, end: literal.end - 1, text: relative.startsWith('.') ? relative : `./${relative}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return text
}

test('every TypeScript runtime source has an up-to-date JavaScript artifact', async () => {
  const sources = await sourceNames()
  assert(sources.length >= 14, 'all original backend and frontend runtime modules are migrated')
  assert.equal(new Set(sources.map(outputName)).size, sources.length, 'runtime sources must have unique flat output names')
  for (const name of sources) {
    const source = await readFile(new URL(`src/${name}`, root), 'utf8')
    assert(!source.includes('@ts-nocheck'), `${name} must remain type-checked`)
    const { outputText } = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: isFrontend(name) ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, useDefineForClassFields: false },
    })
    const output = outputName(name)
    assert.equal(await readFile(new URL(`lib/${output}`, root), 'utf8'), `// Generated from src/${name}; edit the TypeScript source instead.\n${rewriteSpecifiers(outputText, name, sources)}`, `${output} is stale; run npm run build`)
  }
})

test('backend and frontend entry sources are explicit root entrypoints', async () => {
  const names = await sourceFiles()
  assert(names.includes('backend_index.ts'))
  assert(names.includes('frontend_index.ts'))
  assert(!names.includes('frontend/client.ts'))
})

test('sources use .ts and standard ESM syntax with .js relative specifiers', async () => {
  const names = await sourceFiles()
  assert(!names.some(name => /\.(?:mts|cts)$/.test(name)), 'all TypeScript source extensions must be .ts')
  for (const name of names.filter(name => name.endsWith('.ts'))) {
    const source = await readFile(new URL(`src/${name}`, root), 'utf8')
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
    const checkSpecifier = literal => {
      if (literal && ts.isStringLiteral(literal) && /^\.\.?\//.test(literal.text)) {
        assert(literal.text.endsWith('.js'), `${name}: relative source imports (including types) must use .js: ${literal.text}`)
      }
    }
    const visit = node => {
      assert(!ts.isImportEqualsDeclaration(node), `${name} must not use import-equals`)
      assert(!ts.isExportAssignment(node) || !node.isExportEquals, `${name} must not use export =`)
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) checkSpecifier(node.moduleSpecifier)
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) checkSpecifier(node.argument.literal)
      if (ts.isCallExpression(node)) {
        assert(!ts.isIdentifier(node.expression) || node.expression.text !== 'require', `${name} must not call require`)
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) checkSpecifier(node.arguments[0])
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        assert(!ts.isIdentifier(target) || !['exports', 'module'].includes(target.text), `${name} must not assign CommonJS exports`)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})

test('specifier rewriting preserves externals and ordinary string literals', () => {
  const source = `import { a } from './backend/core.js'; export { b } from './frontend/diff.js'; export { remote } from './shared/contract.js'; import external from 'external/core.js'; const text = '../backend/core.js'; const helper = require('./frontend/locales.js'); const dynamic = import('./backend/core.js');`
  assert.equal(rewriteSpecifiers(source, 'frontend_index.ts', ['frontend_index.ts', 'backend/core.ts', 'frontend/diff.ts', 'frontend/locales.ts', 'shared/contract.ts']), `import { a } from './core.mjs'; export { b } from './diff.cjs'; export { remote } from './contract.mjs'; import external from 'external/core.js'; const text = '../backend/core.js'; const helper = require('./locales.cjs'); const dynamic = import('./core.mjs');`)
})

test('frontend bundle recursively embeds local CommonJS modules and delegates only React externals', async () => {
  const source = await readFile(new URL('lib/client.cjs', root), 'utf8')
  const file = ts.createSourceFile('client.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const ids = new Set()
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === '__promptFreezeModules') {
      assert(ts.isObjectLiteralExpression(node.initializer))
      for (const property of node.initializer.properties) {
        assert(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name))
        assert(!ids.has(property.name.text), 'each module has one cached factory')
        ids.add(property.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert(ids.has('frontend_index.cjs'))
  for (const name of await sourceNames()) {
    if (!isFrontend(name) || name.endsWith('client-types.ts')) continue
    assert(ids.has(outputName(name)), `${name} must be reachable in the frontend graph`)
  }
  const requested = []
  const react = { createElement: (type, props) => ({ type, props }) }
  const remote = { sentinel: true }
  const sandbox = { exports: {}, REMOTE: remote, require(id) {
    requested.push(id)
    assert(['react', 'react-dom'].includes(id), `local dependency leaked to external require: ${id}`)
    return react
  } }
  vm.runInNewContext(source, sandbox)
  assert.equal(sandbox.exports.name, 'prompt-freeze/client')
  assert.deepEqual(Object.keys(sandbox.exports).sort(), ['apply', 'inject', 'name'])
  let mounted
  const cleanup = () => {}
  await sandbox.exports.apply({ effect() {}, remote: { async $mount(value) { mounted = value; return cleanup } }, inject() {} })
  assert.equal(mounted, remote, 'all bundled modules retain the enclosing REMOTE binding')
  assert(requested.includes('react'))
})

test('browser bundle mounts its generated REMOTE descriptor through the same module graph', async () => {
  let registration
  const sandbox = { window: { __ModuleLoader__: { load(value) { registration = value } } } }
  vm.runInNewContext(await readFile(new URL('lib/client.js', root), 'utf8'), sandbox)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(registration.id, pkg.name)
  const client = registration.factory(id => {
    assert(['react', 'react-dom'].includes(id))
    return { createElement() {} }
  })
  let mounted
  await client.apply({ effect() {}, remote: { async $mount(value) { mounted = value } }, inject() {} })
  assert.equal(mounted.package, pkg.name)
  assert(mounted.descriptors.length > 0)
})

test('generated runtime artifacts do not remain at the package root', async () => {
  const sources = await sourceNames()
  const rootFiles = new Set((await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name))
  for (const name of sources) {
    const output = outputName(name)
    assert(!rootFiles.has(output), `${output} must exist only under lib/`)
  }
})

test('strict checks stay enabled and sources do not bypass them', async () => {
  const config = JSON.parse(await readFile(new URL('tsconfig.json', root), 'utf8'))
  assert.equal(config.compilerOptions.strict, true)
  for (const flag of ['verbatimModuleSyntax', 'noUnusedLocals', 'noUnusedParameters']) {
    assert.equal(config.compilerOptions[flag], true, `${flag} must remain enabled`)
  }
  for (const flag of ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis', 'useUnknownInCatchVariables']) {
    assert.notEqual(config.compilerOptions[flag], false, `${flag} must not override strict mode`)
  }
  const names = (await sourceFiles()).filter(name => /\.(?:mts|cts|ts)$/.test(name))
  for (const name of names) {
    const source = await readFile(new URL(`src/${name}`, root), 'utf8')
    assert(!/@ts-(?:nocheck|ignore|expect-error)\b/.test(source), `${name} must not suppress compiler diagnostics`)
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
    const visit = node => {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${name} must not replace implicit any with explicit any`)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})

test('remote codecs validate unknown inputs before returning typed values', async () => {
  const { descriptors } = await import('../lib/contract.mjs')
  const apply = descriptors.find(item => item.method === 'applySnapshot')
  const generation = apply.parameters.find(item => item.name === 'expectedGeneration').codec.create().parse
  for (const input of [null, undefined, '1', true, -1, 1.5, NaN, Infinity, {}, []]) assert.throws(() => generation(input))
  assert.equal(generation(0), 0)
  assert.equal(generation(42), 42)
  const status = apply.result.create().parse
  for (const input of [null, undefined, {}, 'status', { sessionId: 's', generation: 0 }]) assert.throws(() => status(input))
  const valid = { sessionId: 's', generation: 0, busy: false, baselineRequired: false, noticeState: 'none' }
  assert.equal(status(valid), valid)
})

test('bundle installation patches live in the published bundles directory', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.deepEqual(pkg.dsh.bundle.patch, ['./bundles/prompt-freeze.patch.yml'])
  assert(pkg.files.includes('bundles'))
  assert(!(await readdir(root)).includes('prompt-freeze.patch.yml'))
  const patch = await readFile(new URL(pkg.dsh.bundle.patch[0], root), 'utf8')
  assert.match(patch, /id: prompt-freeze/)
  assert(patch.includes(`name: '${pkg.name}'`))
})

test('published plugin and remote entry points resolve from lib', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.main, './lib/index.mjs')
  assert.equal(pkg.exports['.'], './lib/index.mjs')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  const plugin = await import('../lib/index.mjs')
  assert.equal(plugin.name, 'prompt-freeze')
  assert.equal(typeof plugin.apply, 'function')
  const { TYPERT } = await import('../lib/typert.host.mjs')
  const { default: remote } = await import('../lib/typert.remote-client.mjs')
  assert.equal(TYPERT.package, pkg.name)
  assert.equal(remote.package, pkg.name)
})
