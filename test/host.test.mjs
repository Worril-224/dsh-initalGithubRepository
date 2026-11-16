/**
 * Host-half integration test.
 *
 * Runs the real plugin `apply()` against a mock Cordis context, a real
 * temporary workspace, and a real local bare git remote.  The browser half is
 * not involved: every assertion goes through the same POST routes the browser
 * uses.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-auto-commit-test-'))
const home = path.join(root, 'home')
const workspace = path.join(root, 'workspace')
const workspace2 = path.join(root, 'workspace2')
const gitWorkspace = path.join(root, 'git-workspace')
const gitRemote = path.join(root, 'git-remote.git')
const remote = path.join(root, 'remote.git')
const conflictRemote = path.join(root, 'conflict.git')
const seed = path.join(root, 'seed')
await fs.mkdir(workspace, { recursive: true })
await fs.mkdir(workspace2, { recursive: true })
await fs.mkdir(gitWorkspace, { recursive: true })
await fs.mkdir(home, { recursive: true })
await fs.mkdir(seed, { recursive: true })
await fs.writeFile(path.join(workspace, 'app.js'), 'export const greeting = "hello"\n', 'utf8')
await fs.writeFile(path.join(workspace2, 'app2.js'), 'export const second = true\n', 'utf8')
await execFileAsync('git', ['init', '--bare', remote])
await execFileAsync('git', ['init', '--bare', conflictRemote])
await execFileAsync('git', ['init', '-b', 'main'], { cwd: seed })
await fs.writeFile(path.join(seed, 'README.md'), '# Seed repository\n', 'utf8')
await execFileAsync('git', ['add', '-A'], { cwd: seed })
await execFileAsync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'Initial commit'], { cwd: seed })
await execFileAsync('git', ['remote', 'add', 'origin', conflictRemote], { cwd: seed })
await execFileAsync('git', ['push', 'origin', 'main'], { cwd: seed })

await fs.writeFile(path.join(gitWorkspace, 'README.md'), '# Git operations workspace\n', 'utf8')
await execFileAsync('git', ['init', '-b', 'main'], { cwd: gitWorkspace })
await execFileAsync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'add', '-A'], { cwd: gitWorkspace })
await execFileAsync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial commit'], { cwd: gitWorkspace })
await execFileAsync('git', ['init', '--bare', gitRemote])
await execFileAsync('git', ['remote', 'add', 'origin', gitRemote], { cwd: gitWorkspace })
await execFileAsync('git', ['push', 'origin', 'main'], { cwd: gitWorkspace })

process.env.DSH_HOME = home

/* A deterministic GitHub API stand-in: token `ghp_test_token` is user `tester`,
   repositories are added by the create-repo route, and everything else is 404. */
const githubState = {
  login: 'tester',
  repos: new Map(),
  created: [],
}
function githubJson(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const method = String(init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  const auth = headers.authorization || headers.Authorization
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return githubJson({ message: 'Bad credentials' }, 401)
  if (method === 'GET' && url.endsWith('/user')) return githubJson({ login: githubState.login, html_url: `https://github.com/${githubState.login}` }, 200)
  const repoMatch = url.match(/\/repos\/([^/]+)\/([^/?#]+)$/)
  if (method === 'GET' && repoMatch) {
    const key = `${repoMatch[1]}/${repoMatch[2]}`
    if (githubState.repos.has(key)) return githubJson(githubState.repos.get(key), 200)
    return githubJson({ message: 'Not Found' }, 404)
  }
  if (method === 'POST' && (url.endsWith('/user/repos') || /\/orgs\/[^/]+\/repos$/.test(url))) {
    const body = JSON.parse(String(init.body || '{}'))
    const owner = url.includes('/orgs/') ? url.split('/orgs/')[1].split('/')[0] : githubState.login
    const key = `${owner}/${body.name}`
    if (githubState.repos.has(key)) return githubJson({ message: 'Repository creation failed', errors: [{ message: 'name already exists' }] }, 422)
    const repo = {
      html_url: `https://github.com/${key}`,
      clone_url: `https://github.com/${key}.git`,
      ssh_url: `git@github.com:${key}.git`,
      full_name: key,
      private: body.private === true,
      default_branch: body.auto_init ? 'main' : null,
    }
    githubState.repos.set(key, repo)
    githubState.created.push({ url, body })
    return githubJson(repo, 201)
  }
  return githubJson({ message: 'Not Found' }, 404)
}

const { apply, __internals } = await import('../index.js')

/* ------------------------------------------------------------------ */
/* mock Harness services                                              */
/* ------------------------------------------------------------------ */

const routes = new Map()
const listeners = new Map()
const disposers = []
const credentials = new Map()
const sessions = new Map()
const sessionRecords = []
const workspaces = []
let workspaceResolvePath = workspace
let lastLlmOptions = null
let readmeReply = '# Test project\n\n## Features\n\n- Greeting endpoint\n'
let lastReadmePrompt = ''

const ctx = {
  get(name) {
    return services[name]
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(listener)
    return () => {
      const list = listeners.get(name)
      if (list) list.splice(list.indexOf(listener), 1)
    }
  },
}

const services = {
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route.fetch)
        return async () => { routes.delete(route.path) }
      },
    },
  },
  credentials: {
    async readRecord(key) {
      return credentials.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(credentials.get(key))
      if (next !== undefined) credentials.set(key, next)
      return next
    },
    async deleteRecord(key) {
      credentials.delete(key)
    },
  },
  workspaceRegistry: {
    get(id) {
      return workspaces.find((workspace) => workspace.id === id)
    },
    list() {
      return workspaces.map((workspace) => ({ ...workspace, sessionIds: [...workspace.sessionIds] }))
    },
    async resolveByPath(candidate) {
      return workspaces.find((workspace) => workspace.path === candidate)
    },
  },
  sessionQuery: {
    async listSessions() {
      return sessionRecords.map((header) => ({ header, live: false, persisted: true }))
    },
    async readTitle() {
      return { title: 'Test session' }
    },
  },
  sessions: {
    get(id) {
      return sessions.get(id)
    },
  },
  workingDirectory: {
    get(session) {
      return session.header.cwd
    },
  },
  agentDefaultModel: {
    currentSelection() {
      return { provider: 'mock', model: 'mock-model' }
    },
  },
  llm: {
    listProviders() {
      return [{ id: 'mock', name: 'Mock provider' }, { id: 'deepseek-account', name: 'DeepSeek account' }]
    },
    async listModels(provider) {
      if (provider === 'mock') return [{ id: 'mock-model', name: 'Mock model' }]
      if (provider === 'deepseek-account') return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
      throw new Error(`unknown provider ${provider}`)
    },
    async *stream(options) {
      lastLlmOptions = options
      if (options.purpose === 'git-auto-commit-readme') {
        lastReadmePrompt = options.messages[0].content[0].text
        if (readmeReply === 'THROW') throw new Error('mock README failure')
        yield { type: 'text-delta', text: readmeReply }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (options.purpose === 'git-repo-description') {
        yield { type: 'text-delta', text: '一个用于测试 Git 自动提交插件的示例项目，包含工作区和会话配置。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: 'feat(core): add greeting endpoint' }
      yield { type: 'text-delta', text: '\n\n- Add app.js' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

workspaces.push({ id: 'ws-1', title: 'Test workspace', path: workspace, sessionIds: [] })
workspaces.push({ id: 'ws-2', title: 'Second workspace', path: workspace2, sessionIds: [] })
workspaces.push({ id: 'ws-git', title: 'Git operations', path: gitWorkspace, sessionIds: [] })
apply(ctx)

async function call(route, body) {
  const handler = routes.get(`/api/dsh-git-auto-commit${route}`)
  assert.ok(handler, `route ${route} is registered`)
  const response = await handler(new Request(`http://localhost/api/dsh-git-auto-commit${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }))
  return response.json()
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('timed out waiting for condition')
}

function makeSession(id, createdAt, fileEvents = [], cwd = workspace, workspaceIndex = 0) {
  const header = { id, createdAt, cwd, version: 1, isSeeded: false }
  const record = { header, live: true, persisted: true }
  sessionRecords.push(header)
  workspaces[workspaceIndex].sessionIds.push(id)
  const live = {
    id,
    header,
    ownEvents() {
      return fileEvents
    },
    requestHeader() {
      return { config: { provider: 'mock', model: 'mock-model' } }
    },
  }
  sessions.set(id, live)
  return live
}

function emit(name, ...args) {
  for (const listener of listeners.get(name) || []) listener(...args)
}

function gitIn(args) {
  return execFileAsync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], { cwd: gitWorkspace })
}

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

/* ------------------------------------------------------------------ */
/* tests                                                              */
/* ------------------------------------------------------------------ */

await test('HTTP push auth uses a header, never a token URL', async () => {
  const token = 'ghp_secret_value'
  const env = __internals.pushEnvironment('https://github.com/acme/repo.git', token)
  assert.equal(env.GIT_CONFIG_COUNT, '1')
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader')
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /)
  assert.equal(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ')[2], 'base64').toString(), `x-access-token:${token}`)
  assert.equal(__internals.pushEnvironment('/tmp/local.git', token).GIT_CONFIG_COUNT, undefined)
})

await test('state route starts empty and off', async () => {
  const state = await call('/state', {})
  assert.equal(state.ok, true)
  assert.equal(state.global.requireConfirmation, true)
  assert.equal(state.tokenConfigured, false)
  assert.equal(state.pending.length, 0)
})

await test('global config saves identity, token, detected account and workspace default', async () => {
  const saved = await call('/config', {
    global: {
      userName: 'Test User',
      userEmail: 'test@example.com',
      requireConfirmation: true,
      defaultBranch: 'main',
    },
    token: 'ghp_test_token',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.tokenConfigured, true)
  assert.equal(saved.githubUserError, null)
  assert.equal(saved.global.githubLogin, 'tester')
  assert.equal(saved.global.githubPrefix, 'https://github.com/tester/')
  const workspaceSaved = await call('/workspace', {
    workspaceId: 'ws-1',
    enabled: true,
    repository: remote,
    branch: 'main',
    updateReadme: true,
  })
  assert.equal(workspaceSaved.ok, true)
  assert.equal(workspaceSaved.config.repository, remote)
  assert.equal(workspaceSaved.config.updateReadme, true)
  const state = await call('/state', {})
  assert.equal(state.global.userName, 'Test User')
  assert.equal(state.workspaces[0].config.repository, remote)
  assert.equal(state.workspaces[0].config.enabled, true)
  assert.equal(state.workspaces[0].config.updateReadme, true)
})

await test('workspace default only reaches a session created afterwards', async () => {
  const now = Date.now()
  makeSession('session-new', now + 5000)
  makeSession('session-old', now - 50000)
  const fresh = await call('/session-state', { sessionId: 'session-new' })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.config.enabled, true)
  assert.equal(fresh.config.repository, remote)
  assert.equal(fresh.config.updateReadme, true)
  assert.equal(fresh.config.source, 'workspace')
  const old = await call('/session-state', { sessionId: 'session-old' })
  assert.equal(old.config.enabled, false)
  assert.equal(old.config.repository, '')
  assert.equal(old.config.updateReadme, false)
  assert.equal(old.config.source, 'none')
})

await test('session override is saved and resolved first', async () => {
  const saved = await call('/session', {
    sessionId: 'session-old',
    enabled: true,
    repository: remote,
    branch: 'main',
    updateReadme: true,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.enabled, true)
  assert.equal(saved.config.updateReadme, true)
  assert.equal(saved.config.source, 'session')
  const preserved = await call('/session', {
    sessionId: 'session-old',
    enabled: true,
    repository: remote,
    branch: 'main',
  })
  assert.equal(preserved.ok, true)
  assert.equal(preserved.config.updateReadme, true)
})

await test('completed turn creates a confirmation proposal with the AI message', async () => {
  const session = makeSession('session-turn', Date.now() + 6000, [
    {
      type: 'tool/call',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ path: 'app.js' }) },
    },
    {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: { message: { role: 'user', content: [{ type: 'text', text: 'Add a greeting endpoint' }] } },
    },
  ])
  await call('/session', { sessionId: session.id, enabled: true, repository: remote, branch: 'main' })
  await fs.writeFile(path.join(workspace, 'app.js'), 'export const greeting = "hello"\nexport const version = 2\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const proposal = await waitFor(async () => {
    const state = await call('/state', {})
    return state.pending.length > 0 ? state.pending[0] : null
  })
  assert.match(proposal.message, /feat\(core\): add greeting endpoint/)
  assert.equal(proposal.branch, 'main')
  assert.ok(proposal.files.includes('app.js'))
})

await test('confirmation commits the edited message and pushes it', async () => {
  const state = await call('/state', {})
  const proposal = state.pending[0]
  const decided = await call('/pending', {
    id: proposal.id,
    action: 'commit',
    message: 'feat: user edited message\n\n- first line body',
  })
  assert.equal(decided.ok, true)
  assert.equal(decided.result.status, 'pushed')
  const { stdout } = await execFileAsync('git', ['--git-dir', remote, 'log', '-1', '--pretty=%B'], { cwd: workspace })
  assert.match(stdout, /feat: user edited message/)
  assert.match(stdout, /first line body/)
  const after = await call('/state', {})
  assert.equal(after.pending.length, 0)
})

await test('skip cancels without committing', async () => {
  const session = makeSession('session-skip', Date.now() + 7000, [])
  await call('/session', { sessionId: session.id, enabled: true, repository: remote, branch: 'main' })
  await fs.writeFile(path.join(workspace, 'skip.txt'), 'skip me\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const proposal = await waitFor(async () => {
    const state = await call('/state', {})
    return state.pending.length > 0 ? state.pending[0] : null
  })
  const decided = await call('/pending', { id: proposal.id, action: 'cancel' })
  assert.equal(decided.status, 'cancelled')
  const { stdout } = await execFileAsync('git', ['--git-dir', remote, 'log', '--pretty=%s'], { cwd: workspace })
  assert.doesNotMatch(stdout, /skip/i)
})

await test('turning confirmation off commits and pushes automatically', async () => {
  await call('/config', { global: { requireConfirmation: false } })
  const session = makeSession('session-auto', Date.now() + 8000, [])
  await call('/session', { sessionId: session.id, enabled: true, repository: remote, branch: 'main' })
  await fs.writeFile(path.join(workspace, 'auto.txt'), 'auto\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-auto' && item.status === 'pushed')
  })
  assert.ok(result)
  const { stdout } = await execFileAsync('git', ['--git-dir', remote, 'log', '-1', '--pretty=%s'], { cwd: workspace })
  assert.match(stdout, /feat\(core\): add greeting endpoint/)
})

await test('a newly created session snapshots the workspace default', async () => {
  const session = makeSession('session-created', Date.now(), [])
  emit('session/created', session)
  const state = await waitFor(async () => {
    const value = await call('/state', {})
    return value.sessions['session-created'] ? value : null
  })
  assert.equal(state.sessions['session-created'].enabled, true)
  assert.equal(state.sessions['session-created'].repository, remote)
  assert.equal(state.sessions['session-created'].updateReadme, true)
  assert.equal(state.sessions['session-created'].source, 'workspace')
})

await test('GitHub shorthand expands against the detected prefix', async () => {
  const prefix = __internals.normalizeGithubPrefix('https://github.com/tester/')
  assert.equal(prefix, 'https://github.com/tester/')
  assert.equal(__internals.expandRepository('my-repo', prefix), 'https://github.com/tester/my-repo')
  assert.equal(__internals.expandRepository('acme/my-repo', prefix), 'https://github.com/acme/my-repo')
  assert.equal(__internals.expandRepository('https://github.com/a/b.git', prefix), 'https://github.com/a/b.git')
  assert.equal(__internals.expandRepository('/tmp/repo.git', prefix), '/tmp/repo.git')
  assert.deepEqual(__internals.parseGitHubRepository('https://github.com/acme/repo.git'), {
    owner: 'acme',
    name: 'repo',
    htmlUrl: 'https://github.com/acme/repo',
  })
})

await test('a missing GitHub workspace repository returns create-repo details', async () => {
  const rejected = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: true,
    repository: 'missing-repo',
    branch: 'main',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'REPO_NOT_FOUND')
  assert.equal(rejected.error.details.owner, 'tester')
  assert.equal(rejected.error.details.name, 'missing-repo')
  assert.equal(rejected.error.details.repository, 'https://github.com/tester/missing-repo')
  assert.equal(rejected.error.details.canCreate, true)
})

await test('saving anyway stores the expanded workspace repository', async () => {
  const saved = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: true,
    repository: 'missing-repo',
    branch: 'main',
    skipRepoCheck: true,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.repository, 'https://github.com/tester/missing-repo')
})

await test('creating the missing repository sends GitHub create fields and becomes findable', async () => {
  const created = await call('/github/create-repo', {
    owner: 'tester',
    name: 'missing-repo',
    description: 'Created by the test',
    private: true,
    autoInit: true,
    hasIssues: true,
    hasProjects: false,
    hasWiki: false,
    gitignoreTemplate: 'Node',
    licenseTemplate: 'MIT',
    homepage: 'https://example.com',
  })
  assert.equal(created.ok, true)
  assert.equal(created.repo.cloneUrl, 'https://github.com/tester/missing-repo.git')
  assert.equal(created.repo.private, true)
  const record = githubState.created.find((item) => item.body.name === 'missing-repo')
  assert.equal(record.body.private, true)
  assert.equal(record.body.auto_init, true)
  assert.equal(record.body.has_projects, false)
  assert.equal(record.body.gitignore_template, 'Node')
  assert.equal(record.body.license_template, 'MIT')
  assert.equal(record.body.homepage, 'https://example.com')
  const saved = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: true,
    repository: 'missing-repo',
    branch: 'main',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.repository, 'https://github.com/tester/missing-repo')
})

await test('a workspace without a git repository can create one proactively', async () => {
  const dir = path.join(root, 'proactive-workspace')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'main.js'), 'export const ok = true\n', 'utf8')
  workspaces.push({ id: 'ws-proactive', title: 'Proactive workspace', path: dir, sessionIds: [] })
  makeSession('session-proactive', Date.now() + 60000, [], dir, 3)

  const statusBefore = await call('/git/repo-status', { workspaceId: 'ws-proactive' })
  assert.equal(statusBefore.ok, true)
  assert.equal(statusBefore.repo, false)
  const before = await call('/git/branches', { workspaceId: 'ws-proactive' })
  assert.equal(before.ok, true)
  assert.equal(before.repo, false)

  const created = await call('/github/create-repo', {
    workspaceId: 'ws-proactive',
    owner: 'tester',
    name: 'proactive-created',
    private: true,
  })
  assert.equal(created.ok, true)
  assert.equal(created.repositoryInitialized, true)
  const top = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir })
  assert.equal(await fs.realpath(top.stdout.trim()), await fs.realpath(dir))

  const statusAfter = await call('/git/repo-status', { workspaceId: 'ws-proactive' })
  assert.equal(statusAfter.ok, true)
  assert.equal(statusAfter.repo, true)
  const after = await call('/git/branches', { workspaceId: 'ws-proactive' })
  assert.equal(after.repo, true)

  const saved = await call('/workspace', {
    workspaceId: 'ws-proactive',
    enabled: true,
    repository: 'https://github.com/tester/proactive-created.git',
    branch: 'main',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.repository, 'https://github.com/tester/proactive-created.git')

  const sync = await call('/git/sync', { sessionId: 'session-proactive' })
  assert.equal(sync.ok, true)
  assert.equal(sync.repo, true)
})

await test('a missing session repository asks before saving unless skipped', async () => {
  const rejected = await call('/session', {
    sessionId: 'session-missing',
    enabled: true,
    repository: 'missing-session-repo',
    branch: 'main',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'REPO_NOT_FOUND')
  const saved = await call('/session', {
    sessionId: 'session-missing',
    enabled: true,
    repository: 'missing-session-repo',
    branch: 'main',
    skipRepoCheck: true,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.repository, 'https://github.com/tester/missing-session-repo')
})

await test('disabling askCreateMissingRepo saves without prompting', async () => {
  const configured = await call('/config', { global: { askCreateMissingRepo: false } })
  assert.equal(configured.ok, true)
  const saved = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: true,
    repository: 'another-missing-repo',
    branch: 'main',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.repository, 'https://github.com/tester/another-missing-repo')
})

await test('an invalid GitHub prefix is rejected', async () => {
  const rejected = await call('/config', { global: { githubPrefix: 'ftp://example.com/' } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'GITHUB_PREFIX_INVALID')
})

await test('AI model catalog lists providers and models', async () => {
  const data = await call('/ai/models', { provider: 'mock' })
  assert.equal(data.ok, true)
  assert.equal(data.provider, 'mock')
  assert.ok(data.providers.some((provider) => provider.id === 'mock'))
  assert.deepEqual(data.models.map((model) => model.id), ['mock-model'])
})

await test('AI description uses the configured provider and project files', async () => {
  const saved = await call('/config', { global: { aiProvider: 'mock', aiModel: 'mock-model' } })
  assert.equal(saved.ok, true)
  const described = await call('/ai/describe', { workspaceId: 'ws-1', language: 'zh' })
  assert.equal(described.ok, true)
  assert.match(described.description, /示例项目/)
  assert.equal(described.provider, 'mock')
  assert.equal(lastLlmOptions.provider, 'mock')
  assert.equal(lastLlmOptions.model, 'mock-model')
  assert.equal(lastLlmOptions.purpose, 'git-repo-description')
  const prompt = lastLlmOptions.messages[0].content[0].text
  assert.match(prompt, /Project folder: workspace/)
  assert.match(prompt, /app\.js/)
})

await test('AI description falls back to the agent default model', async () => {
  const saved = await call('/config', { global: { aiProvider: '', aiModel: '' } })
  assert.equal(saved.ok, true)
  const described = await call('/ai/describe', { workspaceId: 'ws-1', language: 'en' })
  assert.equal(described.ok, true)
  assert.equal(described.provider, 'mock')
  assert.equal(described.model, 'mock-model')
})

await test('a rejected non-fast-forward push merges the remote and retries', async () => {
  const session = makeSession('session-merge', Date.now() + 12000, [])
  const saved = await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: conflictRemote,
    branch: 'main',
  })
  assert.equal(saved.ok, true)
  await fs.writeFile(path.join(workspace, 'merge-test.txt'), 'merge test\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-merge' && item.status === 'pushed')
  })
  assert.equal(result.mergedRemote, true)
  const { stdout: log } = await execFileAsync('git', ['--git-dir', conflictRemote, 'log', '--pretty=%s', 'main'], { cwd: workspace })
  assert.match(log, /Initial commit/)
  assert.match(log, /merge: reconcile remote main before push/)
  const { stdout: files } = await execFileAsync('git', ['--git-dir', conflictRemote, 'ls-tree', '-r', '--name-only', 'main'], { cwd: workspace })
  assert.match(files, /merge-test\.txt/)
})

await test('AI description cleanup strips markdown and caps the GitHub limit', () => {
  assert.equal(__internals.cleanAiDescription('```\n"# 一个项目描述"\n```'), '一个项目描述')
  assert.ok(__internals.cleanAiDescription('x'.repeat(400)).length <= 350)
})

await test('a short repository name without an account prefix is rejected', async () => {
  const reset = await call('/config', { global: { githubPrefix: 'https://github.com/' } })
  assert.equal(reset.ok, true)
  const rejected = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: true,
    repository: 'short-no-owner',
    branch: 'main',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'GITHUB_PREFIX_REQUIRED')
  const restored = await call('/config', { global: { githubPrefix: 'https://github.com/tester/' } })
  assert.equal(restored.ok, true)
})

await test('an invalid workspace branch is rejected without changing the workspace', async () => {
  const before = await call('/state', {})
  const rejected = await call('/workspace', {
    workspaceId: 'ws-1',
    enabled: true,
    repository: remote,
    branch: 'not a branch!',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'BRANCH_INVALID')
  const after = await call('/state', {})
  assert.equal(after.workspaces.find((workspace) => workspace.id === 'ws-1').config.repository, before.workspaces.find((workspace) => workspace.id === 'ws-1').config.repository)
})

await test('an aborted turn is ignored', async () => {
  const before = await call('/state', {})
  const countBefore = before.lastResults.length
  const session = makeSession('session-abort', Date.now() + 9000, [])
  emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted' } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await call('/state', {})
  assert.equal(after.lastResults.length, countBefore)
})

await test('README update uses the commit model and is committed with the change', async () => {
  await call('/config', { global: { aiProvider: 'mock', aiModel: 'mock-model' } })
  readmeReply = '# Test project\n\n## Features\n\n- Greeting endpoint\n'
  const session = makeSession('session-readme', Date.now() + 20000, [])
  session.requestHeader = () => ({ config: { provider: 'session-provider', model: 'session-model' } })
  const saved = await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: remote,
    branch: 'main',
    updateReadme: true,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.updateReadme, true)
  await fs.writeFile(path.join(workspace, 'readme-change.txt'), 'readme change\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-readme' && item.status === 'pushed')
  })
  assert.equal(result.readmeStatus, 'updated')
  assert.equal(result.readmeFile, 'README.md')
  const content = await fs.readFile(path.join(workspace, 'README.md'), 'utf8')
  assert.equal(content, readmeReply)
  assert.equal(lastLlmOptions.purpose, 'git-auto-commit-readme')
  assert.equal(lastLlmOptions.provider, 'mock')
  assert.equal(lastLlmOptions.model, 'mock-model')
  assert.match(lastReadmePrompt, /readme-change\.txt/)
  assert.match(lastReadmePrompt, /feat\(core\): add greeting endpoint/)
  const { stdout: tree } = await execFileAsync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { cwd: workspace })
  assert.match(tree, /README\.md/)
  assert.match(tree, /readme-change\.txt/)
})

await test('README update is skipped when the model returns NO_CHANGE', async () => {
  readmeReply = 'NO_CHANGE'
  const session = makeSession('session-readme-nochange', Date.now() + 21000, [])
  await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: remote,
    branch: 'main',
    updateReadme: true,
  })
  await fs.writeFile(path.join(workspace, 'nochange.txt'), 'no change needed\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-readme-nochange' && item.status === 'pushed')
  })
  assert.equal(result.readmeStatus, 'unchanged')
  const content = await fs.readFile(path.join(workspace, 'README.md'), 'utf8')
  assert.match(content, /Greeting endpoint/)
  const { stdout: tree } = await execFileAsync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { cwd: workspace })
  assert.match(tree, /nochange\.txt/)
})

await test('a README update failure does not block the commit', async () => {
  readmeReply = 'THROW'
  const session = makeSession('session-readme-fail', Date.now() + 22000, [])
  await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: remote,
    branch: 'main',
    updateReadme: true,
  })
  await fs.writeFile(path.join(workspace, 'readme-failure.txt'), 'still committed\n', 'utf8')
  emit('session/event', session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-readme-fail' && item.status === 'pushed')
  })
  assert.equal(result.readmeStatus, 'failed')
  assert.match(result.readmeWarning, /mock README failure/)
  const content = await fs.readFile(path.join(workspace, 'README.md'), 'utf8')
  assert.match(content, /Greeting endpoint/)
  const { stdout: tree } = await execFileAsync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { cwd: workspace })
  assert.match(tree, /readme-failure\.txt/)
})

await test('README update is skipped when no AI model is available', async () => {
  const originalSelection = services.agentDefaultModel.currentSelection
  services.agentDefaultModel.currentSelection = () => undefined
  try {
    await call('/config', { global: { aiProvider: '', aiModel: '' } })
    const session = makeSession('session-readme-noai', Date.now() + 22500, [])
    session.requestHeader = () => ({ config: {} })
    await call('/session', {
      sessionId: session.id,
      enabled: true,
      repository: remote,
      branch: 'main',
      updateReadme: true,
    })
    await fs.writeFile(path.join(workspace, 'noai.txt'), 'commit without AI\n', 'utf8')
    emit('session/event', session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    const result = await waitFor(async () => {
      const state = await call('/state', {})
      return state.lastResults.find((item) => item.sessionId === 'session-readme-noai' && item.status === 'pushed')
    })
    assert.equal(result.readmeStatus, 'skipped')
    assert.match(result.readmeWarning, /No AI model is configured/)
    const { stdout: tree } = await execFileAsync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { cwd: workspace })
    assert.match(tree, /noai\.txt/)
  } finally {
    services.agentDefaultModel.currentSelection = originalSelection
    await call('/config', { global: { aiProvider: 'mock', aiModel: 'mock-model' } })
  }
})

await test('a workspace README-only default reaches a new session but not an old one', async () => {
  const saved = await call('/workspace', {
    workspaceId: 'ws-2',
    enabled: false,
    repository: '',
    branch: 'main',
    updateReadme: true,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.updateReadme, true)
  assert.equal(saved.config.repository, '')
  const session = makeSession('session-ws2-readme', Date.now() + 23000, [], workspace2, 1)
  const resolved = await call('/session-state', { sessionId: session.id })
  assert.equal(resolved.config.updateReadme, true)
  assert.equal(resolved.config.enabled, false)
  assert.equal(resolved.config.repository, '')
  assert.equal(resolved.config.source, 'workspace')
})

await test('the branch catalog lists local and remote branches', async () => {
  const saved = await call('/workspace', {
    workspaceId: 'ws-git',
    enabled: true,
    repository: gitRemote,
    branch: 'main',
  })
  assert.equal(saved.ok, true)
  const catalog = await call('/git/branches', { workspaceId: 'ws-git' })
  assert.equal(catalog.ok, true)
  assert.equal(catalog.current, 'main')
  const main = catalog.branches.find((branch) => branch.name === 'main')
  assert.ok(main)
  assert.equal(main.local, true)
  assert.equal(main.remote, true)
  const bySession = await call('/git/branches', { workspaceId: 'ws-git', repository: gitRemote })
  assert.ok(bySession.branches.some((branch) => branch.name === 'main'))
})

await test('a session stores and validates a new-branch base', async () => {
  const session = makeSession('session-git-new', Date.now() + 30000, [], gitWorkspace, 2)
  const invalid = await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: gitRemote,
    branch: 'feature/one',
    branchBase: 'feature/one',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'BRANCH_BASE_INVALID')
  const saved = await call('/session', {
    sessionId: session.id,
    enabled: true,
    repository: gitRemote,
    branch: 'feature/one',
    branchBase: 'main',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.branchBase, 'main')
  const resolved = await call('/session-state', { sessionId: session.id })
  assert.equal(resolved.config.branchBase, 'main')
})

await test('a new branch is created from its base and committed', async () => {
  const session = sessions.get('session-git-new')
  await fs.writeFile(path.join(gitWorkspace, 'feature.txt'), 'feature one\n', 'utf8')
  const mainCommit = (await gitIn(['rev-parse', 'main'])).stdout.trim()
  emit('session/event', session, { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })
  const result = await waitFor(async () => {
    const state = await call('/state', {})
    return state.lastResults.find((item) => item.sessionId === 'session-git-new' && item.status === 'pushed')
  })
  assert.equal(result.branch, 'feature/one')
  const current = (await gitIn(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  assert.equal(current, 'feature/one')
  const parent = (await gitIn(['rev-parse', 'feature/one^'])).stdout.trim()
  assert.equal(parent, mainCommit)
  const remoteBranches = (await execFileAsync('git', ['--git-dir', gitRemote, 'branch', '--format=%(refname:short)'])).stdout
  assert.match(remoteBranches, /feature\/one/)
  const remoteTree = (await execFileAsync('git', ['--git-dir', gitRemote, 'ls-tree', '-r', '--name-only', 'feature/one'])).stdout
  assert.match(remoteTree, /feature\.txt/)
})

await test('workspace merge combines a branch into the current branch', async () => {
  const mainCommit = (await gitIn(['rev-parse', 'main'])).stdout.trim()
  await gitIn(['checkout', '-b', 'feature/two', mainCommit])
  await fs.writeFile(path.join(gitWorkspace, 'two.txt'), 'two\n', 'utf8')
  await gitIn(['add', '-A'])
  await gitIn(['commit', '-m', 'feat: branch two'])
  await gitIn(['checkout', 'feature/one'])
  const merged = await call('/git/merge', { workspaceId: 'ws-git', source: 'feature/two', push: true })
  assert.equal(merged.ok, true)
  assert.equal(merged.current, 'feature/one')
  assert.equal(merged.merged, true)
  assert.equal(merged.pushed, true)
  assert.match(await fs.readFile(path.join(gitWorkspace, 'two.txt'), 'utf8'), /two/)
  const parents = (await gitIn(['rev-list', '--parents', '-1', 'HEAD'])).stdout.trim().split(' ')
  assert.ok(parents.length >= 3)
  const message = (await gitIn(['log', '-1', '--format=%s'])).stdout.trim()
  assert.match(message, /merge: feature\/two into feature\/one/)
})

await test('workspace rebase replays the current branch onto another branch', async () => {
  const mainCommit = (await gitIn(['rev-parse', 'main'])).stdout.trim()
  await gitIn(['checkout', '-b', 'feature/three', mainCommit])
  await fs.writeFile(path.join(gitWorkspace, 'three.txt'), 'three\n', 'utf8')
  await gitIn(['add', '-A'])
  await gitIn(['commit', '-m', 'feat: branch three'])
  const rebased = await call('/git/rebase', { workspaceId: 'ws-git', onto: 'feature/two', push: false })
  assert.equal(rebased.ok, true)
  assert.equal(rebased.current, 'feature/three')
  assert.equal(rebased.rebased, true)
  const parent = (await gitIn(['rev-parse', 'HEAD^'])).stdout.trim()
  const twoTip = (await gitIn(['rev-parse', 'feature/two'])).stdout.trim()
  assert.equal(parent, twoTip)
  const log = (await gitIn(['log', '-5', '--format=%s'])).stdout
  assert.match(log, /feat: branch three/)
  assert.match(log, /feat: branch two/)
  const tree = (await gitIn(['ls-tree', '-r', '--name-only', 'HEAD'])).stdout
  assert.match(tree, /three\.txt/)
  assert.match(tree, /two\.txt/)
})

await test('the commit graph includes commits and branches', async () => {
  const graph = await call('/git/graph', { sessionId: 'session-git-new' })
  assert.equal(graph.ok, true)
  assert.ok(graph.lines.some((line) => line.type === 'commit'))
  assert.equal(graph.current, 'feature/three')
  for (const name of ['main', 'feature/one', 'feature/two', 'feature/three']) {
    assert.ok(graph.branches.some((branch) => branch.name === name), `branch ${name} is listed`)
  }
  assert.ok(graph.lines.some((line) => line.type === 'commit' && line.refs.includes('feature/three')))
})

await test('merge is refused while the workspace has uncommitted changes', async () => {
  await gitIn(['checkout', 'feature/one'])
  await fs.writeFile(path.join(gitWorkspace, 'dirty.txt'), 'dirty\n', 'utf8')
  const blocked = await call('/git/merge', { workspaceId: 'ws-git', source: 'feature/two', push: false })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'WORKTREE_DIRTY')
  await fs.rm(path.join(gitWorkspace, 'dirty.txt'))
})

await test('rollback restores a commit as a new commit without erasing history', async () => {
  const mainCommit = (await gitIn(['rev-parse', 'main'])).stdout.trim()
  const beforeHead = (await gitIn(['rev-parse', 'HEAD'])).stdout.trim()
  const rolled = await call('/git/rollback', {
    sessionId: 'session-git-new',
    commit: mainCommit,
    message: 'revert: restore initial layout',
    push: false,
  })
  assert.equal(rolled.ok, true)
  assert.equal(rolled.status, 'committed')
  assert.notEqual(rolled.commit, beforeHead)
  assert.equal(rolled.restoredFrom, mainCommit)
  const parent = (await gitIn(['rev-parse', 'HEAD^'])).stdout.trim()
  assert.equal(parent, beforeHead)
  const diff = (await gitIn(['diff', '--name-only', 'HEAD', mainCommit])).stdout.trim()
  assert.equal(diff, '')
  const log = (await gitIn(['log', '--format=%H'])).stdout
  assert.match(log, new RegExp(mainCommit))
  const status = (await gitIn(['status', '--porcelain'])).stdout.trim()
  assert.equal(status, '')
  const files = await fs.readdir(gitWorkspace)
  assert.ok(!files.includes('two.txt'))
  assert.ok(!files.includes('three.txt'))
  assert.ok(!files.includes('feature.txt'))
})

await test('a workspace branch and base are copied to a new session', async () => {
  const saved = await call('/workspace', {
    workspaceId: 'ws-git',
    enabled: true,
    repository: gitRemote,
    branch: 'feature/ws-default',
    branchBase: 'main',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.branch, 'feature/ws-default')
  assert.equal(saved.config.branchBase, 'main')
  const session = makeSession('session-git-ws-default', Date.now() + 40000, [], gitWorkspace, 2)
  const resolved = await call('/session-state', { sessionId: session.id })
  assert.equal(resolved.config.branch, 'feature/ws-default')
  assert.equal(resolved.config.branchBase, 'main')
  assert.equal(resolved.config.source, 'workspace')
})

await test('branch and graph reads prefer local refs and update only on remote changes', async () => {
  const first = await call('/git/branches', { workspaceId: 'ws-git' })
  assert.equal(first.ok, true)
  assert.equal(first.remoteChecked, true)
  const warm = await call('/git/branches', { workspaceId: 'ws-git' })
  assert.equal(warm.updated, false)
  const mainCommit = (await gitIn(['rev-parse', 'main'])).stdout.trim()
  await execFileAsync('git', ['--git-dir', gitRemote, 'branch', 'remote-sync-test', mainCommit])
  const changed = await call('/git/branches', { workspaceId: 'ws-git' })
  assert.equal(changed.updated, true)
  assert.ok(changed.branches.some((branch) => branch.name === 'remote-sync-test' && branch.remote === true))
  const settled = await call('/git/branches', { workspaceId: 'ws-git' })
  assert.equal(settled.updated, false)
  const graph = await call('/git/graph', { sessionId: 'session-git-new' })
  assert.equal(graph.ok, true)
  assert.equal(graph.remoteChecked, true)
  assert.equal(graph.updated, false)
  await execFileAsync('git', ['--git-dir', gitRemote, 'branch', 'remote-graph-test', mainCommit])
  const graphChanged = await call('/git/graph', { sessionId: 'session-git-new' })
  assert.equal(graphChanged.updated, true)
  const graphSettled = await call('/git/graph', { sessionId: 'session-git-new' })
  assert.equal(graphSettled.updated, false)
  assert.ok(graphSettled.lines.some((line) => line.type === 'commit' && line.refs.includes('remote-graph-test')))
})

await test('sync detects local commits ahead of the cloud and manual commit pushes them', async () => {
  const before = await call('/git/sync', { sessionId: 'session-git-new' })
  assert.equal(before.ok, true)
  assert.equal(before.remoteChecked, true)
  assert.equal(before.dirty, false)
  assert.equal(before.outOfSync, true)
  assert.equal(before.ahead, 1)
  const manual = await call('/git/manual-commit', { sessionId: 'session-git-new', language: 'zh' })
  assert.equal(manual.ok, true)
  assert.equal(manual.mode, 'push')
  assert.equal(manual.result.status, 'pushed')
  assert.equal(manual.result.pushedOnly, true)
  const after = await call('/git/sync', { sessionId: 'session-git-new' })
  assert.equal(after.inSync, true)
  assert.equal(after.remoteHead, after.localHead)
})

await test('manual commit proposes and commits uncommitted changes', async () => {
  await call('/config', { global: { requireConfirmation: true } })
  await fs.writeFile(path.join(gitWorkspace, 'manual-one.txt'), 'manual one\n', 'utf8')
  const proposed = await call('/git/manual-commit', { sessionId: 'session-git-new', language: 'zh' })
  assert.equal(proposed.ok, true)
  assert.equal(proposed.mode, 'proposed')
  const state = await call('/state', {})
  const pending = state.pending.find((item) => item.sessionId === 'session-git-new')
  assert.ok(pending)
  assert.equal(pending.manual, true)
  const decided = await call('/pending', { id: pending.id, action: 'commit', message: pending.message })
  assert.equal(decided.ok, true)
  assert.equal(decided.result.status, 'pushed')
  await call('/config', { global: { requireConfirmation: false } })
  await fs.writeFile(path.join(gitWorkspace, 'manual-two.txt'), 'manual two\n', 'utf8')
  const direct = await call('/git/manual-commit', { sessionId: 'session-git-new', language: 'zh' })
  assert.equal(direct.ok, true)
  assert.equal(direct.mode, 'commit')
  assert.equal(direct.result.status, 'pushed')
})

await test('README fence stripping keeps real content', () => {
  assert.equal(__internals.stripMarkdownFence('```markdown\n# Hi\n```'), '# Hi')
  assert.equal(__internals.stripMarkdownFence('NO_CHANGE'), 'NO_CHANGE')
  assert.equal(__internals.stripMarkdownFence('  ```\n# Hi\n```  '), '# Hi')
})

/* ------------------------------------------------------------------ */
/* cleanup                                                            */
/* ------------------------------------------------------------------ */

for (const dispose of disposers) {
  try {
    await dispose()
  } catch {
    // best effort
  }
}
await fs.rm(root, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall host tests passed')
