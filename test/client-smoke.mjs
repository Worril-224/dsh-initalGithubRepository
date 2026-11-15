/**
 * Client-half smoke test.
 *
 * Executes the real `client.js` factory with a minimal React/DOM/loader stub
 * and a mock Cordis context. It does not render React components; it ensures
 * the module loads, `apply()` runs, and every seat is registered.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}
const styleElements = []
globalThis.document = {
  createElement(tag) {
    return {
      tag,
      dataset: {},
      textContent: '',
      remove() {},
    }
  },
  head: {
    appendChild(element) {
      styleElements.push(element)
    },
  },
  body: {},
  activeElement: null,
  contains() {
    return true
  },
}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      ok: true,
      global: { userName: '', userEmail: '', requireConfirmation: true, defaultBranch: 'main' },
      workspaces: [],
      sessions: {},
      pending: [],
      lastResults: [],
      tokenConfigured: false,
    }
  },
})
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

const ReactStub = {
  createElement() { return null },
  useState() { return [undefined, () => {}] },
  useEffect() {},
  useRef() { return { current: null } },
  useCallback(fn) { return fn },
}
const reactDomStub = { createPortal() { return null } }
const stubRequire = (name) => {
  if (name === 'react') return ReactStub
  if (name === 'react-dom') return reactDomStub
  throw new Error(`unexpected require: ${name}`)
}

const script = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'require', 'module', 'exports', source)
script(
  globalThis.window,
  globalThis.document,
  globalThis.fetch,
  globalThis.setInterval,
  globalThis.clearInterval,
  stubRequire,
  { exports: {} },
  {},
)

assert.ok(definition, 'client module registers a loader definition')
assert.equal(definition.id, '@local/dsh-git-auto-commit')
const plugin = definition.factory(stubRequire)
assert.ok(plugin && typeof plugin.apply === 'function', 'factory returns an apply function')
assert.deepEqual(plugin.inject, ['slots', 'locale', 'contextMenus'])

const registrations = []
const menuContributions = []
const disposers = []
let localeTables = null
const ctx = {
  locale: {
    register(namespace, tables) {
      localeTables = tables
      return () => {}
    },
    bind() { return (key) => key },
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  contextMenus: {
    register(contribution) {
      menuContributions.push(contribution)
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)
assert.equal(registrations.length, 6, 'six seats are registered')
assert.equal(menuContributions.length, 1, 'workspace menu contribution is registered')
assert.equal(menuContributions[0].target, 'workspace')
const byName = new Map(registrations.map((entry) => [entry.options.name, entry.options]))
assert.equal(byName.get('sidebar.workspaces.session.row.action').id, 'git-auto-commit')
assert.equal(byName.get('sidebar.session.row.trailing').id, 'git-auto-commit-trailing')
assert.equal(byName.get('sidebar.workspaces.session.menu.item').id, 'git-auto-commit-menu')
assert.equal(byName.get('sidebar.session.action').id, 'git-auto-commit-settings')
assert.equal(byName.get('shell.overlay').id, 'git-auto-commit-overlay')
assert.equal(byName.get('contextMenu.icon').key, 'workspace.git')
assert.ok(styleElements.length >= 1, 'plugin stylesheet inserted')

assert.ok(localeTables && localeTables.zh && localeTables.en, 'locale tables are registered')
for (const [locale, table] of Object.entries(localeTables)) {
  for (const key of [
    'confirm.autoHide',
    'confirm.hide',
    'confirm.workingHint',
    'confirm.readmeHint',
    'session.background',
    'session.updateReadme',
    'workspace.updateReadme',
    'toast.readmeUpdated',
    'toast.readmeWarning',
    'branch.newOption',
    'branch.createTitle',
    'workspace.branchOps',
    'workspace.merge',
    'workspace.rebase',
    'rollback.open',
    'rollback.submit',
    'confirm.branchBase',
    'branch.createdHint',
  ]) {
    assert.equal(typeof table[key], 'string', `${locale} has ${key}`)
    assert.ok(table[key].length > 0, `${locale} ${key} is not empty`)
  }
}

for (const dispose of disposers.reverse()) {
  try { dispose() } catch { /* best effort */ }
}
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
console.log('all client smoke tests passed')
