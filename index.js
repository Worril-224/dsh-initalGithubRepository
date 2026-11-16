/**
 * dsh-git-auto-commit — Host half.
 *
 * Adds an opt-in git commit + push step after every completed turn:
 *   - the session can carry its own repository, branch and enabled flag;
 *   - a workspace carries defaults copied into *new* sessions only;
 *   - the commit message is generated from the files the agent changed during
 *     that turn (Conventional Commits shape) and may require user confirmation.
 *
 * The browser half talks to this file through five same-origin POST routes
 * under `/api/dsh-git-auto-commit/*`.  State is a small JSON document under
 * `$DSH_HOME/git-auto-commit/state.json`; the GitHub token lives in the
 * Harness credential store, never in that document.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

const PLUGIN = 'dsh-git-auto-commit'
const ROUTE_PREFIX = '/api/dsh-git-auto-commit'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'git-auto-commit')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const TOKEN_KEY = 'dsh-git-auto-commit/github-token'
const REMOTE_NAME = 'dsh-auto-commit'
const MAX_PENDING_MS = 30 * 60 * 1000
const MAX_RESULTS = 40
const MAX_DIFF_CHARS = 14000
const GIT_TIMEOUT_MS = 180000
const LLM_TIMEOUT_MS = 30000
const README_LLM_TIMEOUT_MS = 45000
const REMOTE_CHECK_TIMEOUT_MS = 15000
const MAX_README_CHARS = 12000
const MAX_README_OUTPUT_CHARS = 60000
const README_CANDIDATES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README', 'README.rst', 'readme.rst']
const README_NAME_PATTERN = /^readme(?:\.(?:md|markdown|rst|txt))?$/i

const DEFAULT_STATE = {
  version: 1,
  global: {
    userName: '',
    userEmail: '',
    requireConfirmation: true,
    defaultBranch: 'main',
    githubLogin: '',
    githubPrefix: 'https://github.com/',
    askCreateMissingRepo: true,
    aiProvider: '',
    aiModel: '',
  },
  workspaces: {},
  sessions: {},
  lastResults: [],
}

/* ------------------------------------------------------------------ */
/* state document                                                     */
/* ------------------------------------------------------------------ */

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function normalizeRepoConfig(raw) {
  const value = asRecord(raw)
  if (value === null) return null
  const config = {
    enabled: value.enabled === true,
    repository: typeof value.repository === 'string' ? value.repository.trim() : '',
    branch: typeof value.branch === 'string' && value.branch.trim() !== '' ? value.branch.trim() : '',
    branchBase: typeof value.branchBase === 'string' ? value.branchBase.trim() : '',
    updateReadme: value.updateReadme === true,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  }
  if (value.source === 'workspace' || value.source === 'session') config.source = value.source
  return config
}

function normalizeState(raw) {
  const value = asRecord(raw)
  const next = cloneJson(DEFAULT_STATE)
  if (value === null) return next
  const global = asRecord(value.global)
  if (global !== null) {
    if (typeof global.userName === 'string') next.global.userName = global.userName
    if (typeof global.userEmail === 'string') next.global.userEmail = global.userEmail
    if (typeof global.requireConfirmation === 'boolean') next.global.requireConfirmation = global.requireConfirmation
    if (typeof global.defaultBranch === 'string' && global.defaultBranch.trim() !== '') next.global.defaultBranch = global.defaultBranch.trim()
    if (typeof global.githubLogin === 'string') next.global.githubLogin = global.githubLogin.trim()
    if (typeof global.githubPrefix === 'string') {
      const prefix = normalizeGithubPrefix(global.githubPrefix)
      if (prefix !== null) next.global.githubPrefix = prefix
    }
    if (typeof global.askCreateMissingRepo === 'boolean') next.global.askCreateMissingRepo = global.askCreateMissingRepo
    if (typeof global.aiProvider === 'string') next.global.aiProvider = global.aiProvider.trim()
    if (typeof global.aiModel === 'string') next.global.aiModel = global.aiModel.trim()
  }
  const workspaces = asRecord(value.workspaces)
  if (workspaces !== null) {
    for (const [id, config] of Object.entries(workspaces)) {
      const normalized = normalizeRepoConfig(config)
      if (normalized !== null) next.workspaces[id] = normalized
    }
  }
  const sessions = asRecord(value.sessions)
  if (sessions !== null) {
    for (const [id, config] of Object.entries(sessions)) {
      const normalized = normalizeRepoConfig(config)
      if (normalized !== null) next.sessions[id] = normalized
    }
  }
  if (Array.isArray(value.lastResults)) {
    next.lastResults = value.lastResults.filter((item) => asRecord(item) !== null).slice(0, MAX_RESULTS)
  }
  return next
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/* ------------------------------------------------------------------ */
/* small utilities                                                    */
/* ------------------------------------------------------------------ */

function isCjkText(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
}

function firstLine(text, max = 72) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function truncate(text, max) {
  const value = String(text || '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  return textOfContent(message.content)
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw)
    return asRecord(value)
  } catch {
    return null
  }
}

function pathArguments(args) {
  if (args === null) return []
  const found = []
  for (const key of ['path', 'file_path', 'filePath', 'notebook_path', 'target_file']) {
    if (typeof args[key] === 'string') found.push(args[key])
  }
  if (typeof args.input === 'string') {
    const matches = args.input.matchAll(/\*{3}\s+(?:Update|Add|Delete) File:\s*(.+)/g)
    for (const match of matches) found.push(match[1].trim())
  }
  return found
}

function validBranch(branch) {
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith('-') && !branch.startsWith('.') && !branch.endsWith('/')
}

function looksLikeRemote(repository) {
  return /^(?:https?|ssh|git|file):\/\//i.test(repository) || /^[^\s@]+@[^\s@]+:/.test(repository)
}

function isNonFastForwardPush(error) {
  const text = String(error && error.message ? error.message : error || '').toLowerCase()
  return text.includes('non-fast-forward')
    || text.includes('fetch first')
    || text.includes('updates were rejected')
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function normalizeGithubPrefix(raw) {
  let value = String(raw === undefined || raw === null ? '' : raw).trim()
  if (value === '') return 'https://github.com/'
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.search = ''
    url.hash = ''
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${pathname}/`
  } catch {
    return null
  }
}

function githubOrigin(prefix) {
  try {
    return new URL(prefix).origin
  } catch {
    return 'https://github.com'
  }
}

function autoGithubPrefix(login) {
  const normalized = String(login || '').trim()
  if (normalized === '') return 'https://github.com/'
  return normalizeGithubPrefix(`https://github.com/${normalized}/`)
}

function githubPrefixHasAccount(prefix) {
  try {
    return new URL(prefix).pathname.replace(/^\/+|\/+$/g, '') !== ''
  } catch {
    return false
  }
}

function isShortRepositoryName(repository) {
  return repository !== ''
    && !looksLikeRemote(repository)
    && !repository.startsWith('/')
    && !repository.startsWith('./')
    && !repository.startsWith('../')
    && !repository.startsWith('~')
    && !repository.includes('/')
}

function expandRepository(repository, prefix) {
  const value = String(repository || '').trim()
  if (value === '') return ''
  if (
    looksLikeRemote(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~')
  ) return value
  const normalizedPrefix = normalizeGithubPrefix(prefix) || 'https://github.com/'
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return `${githubOrigin(normalizedPrefix)}/${value}`
  }
  if (/^[A-Za-z0-9_.-]+$/.test(value)) {
    return `${normalizedPrefix}${value}`
  }
  return value
}

function parseGitHubRepository(repository) {
  try {
    const url = new URL(repository)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2) return null
    const name = parts[1].replace(/\.git$/i, '')
    if (parts[0] === '' || name === '') return null
    return {
      owner: parts[0],
      name,
      htmlUrl: `https://github.com/${parts[0]}/${name}`,
    }
  } catch {
    return null
  }
}

const PROJECT_IGNORES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next',
  '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage',
  '.turbo', '.parcel-cache', '.pytest_cache', '.mypy_cache',
])

async function readProjectText(file, max) {
  try {
    const info = await fs.stat(file)
    if (!info.isFile() || info.size > 512 * 1024) return ''
    const text = await fs.readFile(file, 'utf8')
    return text.slice(0, max)
  } catch {
    return ''
  }
}

async function collectProjectProfile(cwd) {
  const profile = {
    folder: path.basename(cwd),
    packageJson: null,
    readme: '',
    metadata: [],
    topLevel: [],
    nested: [],
    samples: [],
  }
  const packageRaw = await readProjectText(path.join(cwd, 'package.json'), 20000)
  if (packageRaw !== '') {
    try {
      profile.packageJson = JSON.parse(packageRaw)
    } catch {
      profile.packageJson = null
    }
  }
  for (const readmeName of ['README.md', 'README', 'readme.md', 'README.rst']) {
    const text = (await readProjectText(path.join(cwd, readmeName), 4000)).trim()
    if (text !== '') {
      profile.readme = text
      break
    }
  }
  if (profile.packageJson !== null) {
    const data = profile.packageJson
    const deps = data.dependencies && typeof data.dependencies === 'object' ? Object.keys(data.dependencies).slice(0, 40) : []
    const devDeps = data.devDependencies && typeof data.devDependencies === 'object' ? Object.keys(data.devDependencies).slice(0, 40) : []
    const scripts = data.scripts && typeof data.scripts === 'object' ? Object.keys(data.scripts).slice(0, 20) : []
    profile.metadata.push([
      'package.json',
      data.name ? `name=${data.name}` : '',
      data.description ? `description=${data.description}` : '',
      data.type ? `type=${data.type}` : '',
      scripts.length > 0 ? `scripts=${scripts.join(', ')}` : '',
      deps.length > 0 ? `dependencies=${deps.join(', ')}` : '',
      devDeps.length > 0 ? `devDependencies=${devDeps.join(', ')}` : '',
    ].filter(Boolean).join('; '))
  }
  for (const [file, label] of [
    ['pyproject.toml', 'Python project metadata'],
    ['Cargo.toml', 'Rust project metadata'],
    ['go.mod', 'Go module metadata'],
    ['composer.json', 'PHP Composer metadata'],
    ['pom.xml', 'Maven project metadata'],
    ['build.gradle', 'Gradle project metadata'],
    ['requirements.txt', 'Python requirements'],
    ['Gemfile', 'Ruby dependencies'],
  ]) {
    const text = (await readProjectText(path.join(cwd, file), 3000)).trim()
    if (text !== '') profile.metadata.push(`${label} (${file}):\n${text.slice(0, 2500)}`)
  }
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    profile.topLevel = entries
      .filter((entry) => !PROJECT_IGNORES.has(entry.name) && !entry.name.startsWith('.'))
      .slice(0, 80)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
  } catch {
    profile.topLevel = []
  }
  for (const dir of ['src', 'app', 'lib', 'packages', 'apps', 'components', 'cmd', 'server', 'client']) {
    try {
      const entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true })
      for (const entry of entries.slice(0, 25)) {
        profile.nested.push(`${dir}/${entry.name}${entry.isDirectory() ? '/' : ''}`)
      }
    } catch {
      // A missing conventional directory is normal.
    }
  }
  const sourcePattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|vue|svelte|php|rb|cs|swift)$/i
  const samples = []
  for (const dir of ['', 'src', 'app', 'lib', 'cmd', 'server', 'client', 'packages']) {
    try {
      const entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !sourcePattern.test(entry.name)) continue
        if (/test|spec/i.test(entry.name)) continue
        samples.push(path.join(dir, entry.name))
      }
    } catch {
      // Missing conventional source directories are normal.
    }
  }
  for (const file of samples.slice(0, 4)) {
    const text = (await readProjectText(path.join(cwd, file), 1600)).trim()
    if (text !== '') profile.samples.push({ file, text })
  }
  return profile
}

async function readProjectReadme(cwd) {
  for (const name of README_CANDIDATES) {
    const file = path.join(cwd, name)
    try {
      const info = await fs.stat(file)
      if (!info.isFile()) continue
      if (info.size > MAX_README_CHARS * 8) return { name, file, content: null, existed: true }
      const content = await fs.readFile(file, 'utf8')
      return { name, file, content, existed: true }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true })
    const match = entries
      .filter((entry) => entry.isFile() && README_NAME_PATTERN.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0]
    if (match !== undefined) {
      const file = path.join(cwd, match.name)
      const info = await fs.stat(file)
      if (info.size > MAX_README_CHARS * 8) return { name: match.name, file, content: null, existed: true }
      const content = await fs.readFile(file, 'utf8')
      return { name: match.name, file, content, existed: true }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { name: 'README.md', file: path.join(cwd, 'README.md'), content: '', existed: false }
}

function stripMarkdownFence(raw) {
  const text = String(raw || '').trim()
  if (text.startsWith('```') && text.endsWith('```')) {
    const firstBreak = text.indexOf('\n')
    if (firstBreak !== -1) return text.slice(firstBreak + 1, -3).trim()
  }
  return text
}

function cleanAiDescription(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (text === '') return ''
  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim()
  text = text.replace(/^(?:description|项目描述|仓库描述)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  text = text.replace(/^[#>*\-\s]+/, '').trim()
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 350) text = text.slice(0, 349).trimEnd() + '…'
  return text
}

async function withTimeout(promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function githubRequest(route, token, options = {}) {
  if (typeof token !== 'string' || token === '') throw new Error('A GitHub token is required')
  const response = await fetch(`https://api.github.com${route}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-git-auto-commit',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  let data = null
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error(data && data.message ? data.message : `GitHub API HTTP ${response.status}`)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

async function fetchGitHubUser(token) {
  const data = await githubRequest('/user', token)
  if (data === null || typeof data.login !== 'string' || data.login === '') {
    throw new Error('GitHub did not return an account login')
  }
  return data
}

async function checkGitHubRepo(token, owner, name) {
  try {
    const data = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token)
    return { exists: true, repo: data }
  } catch (error) {
    if (error.status === 404) return { exists: false }
    throw error
  }
}

async function createGitHubRepo(token, payload, login) {
  const owner = String(payload.owner || '').trim()
  const currentLogin = login || (await fetchGitHubUser(token)).login
  const onUser = owner === '' || owner.toLowerCase() === currentLogin.toLowerCase()
  const route = onUser ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`
  const body = {
    name: payload.name,
    description: payload.description || '',
    private: payload.private === true,
    auto_init: payload.autoInit === true,
    has_issues: payload.hasIssues !== false,
    has_projects: payload.hasProjects !== false,
    has_wiki: payload.hasWiki !== false,
  }
  if (typeof payload.homepage === 'string' && payload.homepage.trim() !== '') body.homepage = payload.homepage.trim()
  if (typeof payload.gitignoreTemplate === 'string' && payload.gitignoreTemplate.trim() !== '') body.gitignore_template = payload.gitignoreTemplate.trim()
  if (typeof payload.licenseTemplate === 'string' && payload.licenseTemplate.trim() !== '') body.license_template = payload.licenseTemplate.trim()
  return githubRequest(route, token, { method: 'POST', body })
}

function pushEnvironment(url, token) {
  const env = { GIT_ASKPASS: 'true' }
  if (!token) return env
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return env
    if (parsed.username !== '') return env
    // Prefer an HTTP header over a token-bearing URL: the token then never
    // appears in `.git/config`, argv, or a git error message.
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
  } catch {
    // Non-URL remotes (local paths, scp-style SSH) need no HTTP auth.
  }
  return env
}

async function runGit(args, cwd, extraEnv = {}, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...extraEnv,
      },
    })
    return result
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    const detail = stderr || stdout || error?.message || 'git command failed'
    const wrapped = new Error(detail)
    wrapped.code = error?.code
    wrapped.gitArgs = args
    wrapped.stderr = stderr
    throw wrapped
  }
}

function runGitInput(args, cwd, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...extraEnv,
      },
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const text = (typeof stderr === 'string' ? stderr.trim() : '') || (typeof stdout === 'string' ? stdout.trim() : '') || error.message || 'git command failed'
        const wrapped = new Error(text)
        wrapped.code = error.code
        wrapped.gitArgs = args
        wrapped.stderr = stderr
        reject(wrapped)
        return
      }
      resolve({ stdout, stderr })
    })
    if (child.stdin !== null && child.stdin !== undefined) child.stdin.end(input)
  })
}

async function isRepoRoot(cwd) {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], cwd)
    const top = stdout.trim()
    if (top === '') return false
    const [realTop, realCwd] = await Promise.all([fs.realpath(top), fs.realpath(cwd)])
    return realTop === realCwd
  } catch {
    return false
  }
}

async function ensureRepoRoot(cwd, branch) {
  if (await isRepoRoot(cwd)) return false
  await runGit(['init', '-b', branch], cwd)
  return true
}

function parseStatusFiles(stdout) {
  const files = []
  for (const line of String(stdout || '').split('\n')) {
    if (line.length < 4) continue
    let file = line.slice(3).trim()
    if (file === '') continue
    const rename = file.indexOf(' -> ')
    if (rename >= 0) file = file.slice(rename + 4).trim()
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)
    files.push(file)
  }
  return [...new Set(files)]
}

async function inspectChanges(cwd, branch) {
  await ensureRepoRoot(cwd, branch)
  const status = await runGit(['status', '--porcelain=v1', '-uall', '--', '.'], cwd)
  const files = parseStatusFiles(status.stdout)
  if (files.length === 0) {
    return { files, stat: '', diff: '', untrackedSamples: [] }
  }
  let stat = ''
  let diff = ''
  try {
    stat = truncate((await runGit(['diff', '--stat', '--', '.'], cwd)).stdout.trim(), 4000)
  } catch {
    stat = ''
  }
  try {
    diff = truncate((await runGit(['diff', '--no-color', '--unified=2', '--', '.'], cwd)).stdout, MAX_DIFF_CHARS)
  } catch {
    diff = ''
  }
  let untracked = []
  try {
    const { stdout } = await runGit(['ls-files', '--others', '--exclude-standard', '--', '.'], cwd)
    untracked = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    untracked = []
  }
  const untrackedSamples = []
  let budget = 6000
  for (const file of untracked.slice(0, 10)) {
    if (budget <= 0) break
    try {
      const full = path.join(cwd, file)
      const info = await fs.stat(full)
      if (!info.isFile() || info.size > 256 * 1024) continue
      const text = await fs.readFile(full, 'utf8')
      const sample = truncate(text, Math.min(1500, budget))
      budget -= sample.length
      untrackedSamples.push({ file, sample })
    } catch {
      // Binary or unreadable files are represented by their name only.
    }
  }
  return { files, stat, diff, untrackedSamples }
}

function normalizeCommitMessage(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (text === '') return ''
  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim()
  text = text.replace(/^(?:commit message|commit|message)\s*:\s*/i, '').trim()
  const lines = text.split('\n')
  // Drop markdown headings and bullet decoration on the subject line.
  lines[0] = lines[0].replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim()
  const subject = firstLine(lines[0], 100)
  if (subject === '') return ''
  const body = lines.slice(1).join('\n').trim()
  return body === '' ? subject : `${subject}\n\n${body}`
}

function splitCommitMessage(message) {
  const text = String(message || '').replace(/\r\n/g, '\n').trim()
  const index = text.indexOf('\n')
  if (index < 0) return { subject: firstLine(text, 100), body: '' }
  return {
    subject: firstLine(text.slice(0, index), 100),
    body: text.slice(index + 1).trim(),
  }
}

function parseGitGraphLog(stdout) {
  const lines = []
  for (const raw of String(stdout || '').split('\n')) {
    if (raw === '') continue
    const match = raw.match(/([0-9a-f]{40})/)
    if (match === null) {
      lines.push({ type: 'graph', graph: raw })
      continue
    }
    const graph = raw.slice(0, match.index)
    const fields = raw.slice(match.index + 40).replace(/^\x1f/, '').split('\x1f')
    lines.push({
      type: 'commit',
      graph,
      hash: match[1],
      parents: (fields[0] || '').split(' ').filter(Boolean),
      short: fields[1] || match[1].slice(0, 7),
      subject: fields[2] || '',
      refs: fields[3] || '',
      author: fields[4] || '',
      date: fields[5] || '',
    })
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* plugin                                                             */
/* ------------------------------------------------------------------ */

export const inject = ['connection']

export function apply(ctx) {
  let state = cloneJson(DEFAULT_STATE)
  let saveChain = Promise.resolve()
  const pending = new Map()
  const sessionQueues = new Map()
  let sessionHeadersCache = { at: 0, map: new Map() }
  let disposed = false

  const stateReady = (async () => {
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf8')
      state = normalizeState(JSON.parse(raw))
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`[${PLUGIN}] could not read state:`, error)
      state = cloneJson(DEFAULT_STATE)
    }
  })()

  ctx.effect(() => () => {
    disposed = true
    pending.clear()
  }, `${PLUGIN}: lifecycle`)

  function persist() {
    const snapshot = JSON.stringify(state, null, 2)
    saveChain = saveChain
      .then(() => writeAtomic(STATE_FILE, snapshot))
      .catch((error) => console.error(`[${PLUGIN}] could not save state:`, error))
    return saveChain
  }

  function service(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  async function readToken() {
    const credentials = service('credentials')
    if (credentials === undefined) return undefined
    try {
      const record = await credentials.readRecord(TOKEN_KEY)
      if (record === null || record === undefined) return undefined
      if (record.kind !== 'api-key' || typeof record.key !== 'string' || record.key === '') return undefined
      return record.key
    } catch (error) {
      console.error(`[${PLUGIN}] could not read token:`, error)
      return undefined
    }
  }

  async function writeToken(token) {
    const credentials = service('credentials')
    if (credentials === undefined) throw new Error('Credential store is unavailable in this profile')
    await credentials.modifyRecord(TOKEN_KEY, async () => ({ kind: 'api-key', key: token }))
  }

  async function clearToken() {
    const credentials = service('credentials')
    if (credentials === undefined) return
    await credentials.deleteRecord(TOKEN_KEY)
  }

  async function sessionHeader(sessionId) {
    const live = service('sessions')?.get(sessionId)
    if (live !== undefined) return live.header
    const sessionQuery = service('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') return undefined
    if (Date.now() - sessionHeadersCache.at > 5000) {
      try {
        const records = await sessionQuery.listSessions()
        const map = new Map()
        for (const record of records) map.set(record.header.id, record.header)
        sessionHeadersCache = { at: Date.now(), map }
      } catch {
        // Keep the previous cache; a failed listing must not fail the dialog.
      }
    }
    return sessionHeadersCache.map.get(sessionId)
  }

  async function workspaceForSession(sessionId, cwd) {
    const registry = service('workspaceRegistry')
    if (registry === undefined) return undefined
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace !== undefined) return workspace
      } catch {
        // A missing directory or a directory outside a workspace falls through.
      }
    }
    try {
      for (const workspace of registry.list()) {
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace
      }
    } catch {
      // Registry listing is best effort.
    }
    return undefined
  }

  function resolveBranch(config, fallback) {
    return config?.branch && config.branch !== '' ? config.branch : fallback || state.global.defaultBranch || 'main'
  }

  function resolvedSessionConfig(sessionId, config, workspace, source) {
    return {
      sessionId,
      enabled: config?.enabled === true,
      repository: expandRepository(config?.repository || '', state.global.githubPrefix),
      branch: resolveBranch(config),
      branchBase: config?.branchBase || '',
      updateReadme: config?.updateReadme === true,
      source,
      workspaceId: workspace?.id,
      workspaceTitle: workspace?.title,
      workspacePath: workspace?.path,
    }
  }

  async function resolveSessionConfig(sessionId) {
    await stateReady
    const workspace = await workspaceForSession(
      sessionId,
      (await sessionHeader(sessionId))?.cwd,
    )
    const own = state.sessions[sessionId]
    if (own !== undefined) {
      return resolvedSessionConfig(sessionId, own, workspace, own.source === 'workspace' ? 'workspace' : 'session')
    }

    const workspaceConfig = workspace === undefined ? undefined : state.workspaces[workspace.id]
    if (workspaceConfig === undefined || (workspaceConfig.repository === '' && workspaceConfig.updateReadme !== true)) {
      return resolvedSessionConfig(sessionId, undefined, workspace, 'none')
    }

    const header = await sessionHeader(sessionId)
    // A workspace default is a template for sessions created *after* it was
    // saved.  An older session keeps whatever it had (usually disabled).
    if (header === undefined || !Number.isFinite(header.createdAt) || header.createdAt < workspaceConfig.updatedAt) {
      return resolvedSessionConfig(sessionId, undefined, workspace, 'none')
    }
    const snapshot = {
      enabled: workspaceConfig.enabled === true,
      repository: workspaceConfig.repository,
      branch: resolveBranch(workspaceConfig),
      branchBase: workspaceConfig.branchBase || '',
      updateReadme: workspaceConfig.updateReadme === true,
      updatedAt: Date.now(),
      source: 'workspace',
    }
    state.sessions[sessionId] = snapshot
    void persist()
    return resolvedSessionConfig(sessionId, snapshot, workspace, 'workspace')
  }

  async function snapshotWorkspaceDefault(session) {
    await stateReady
    if (session.header.origin === 'subagent') return
    if (state.sessions[session.id] !== undefined) return
    const workspace = await workspaceForSession(session.id, session.header.cwd)
    if (workspace === undefined) return
    const config = state.workspaces[workspace.id]
    if (config === undefined || (config.repository === '' && config.updateReadme !== true)) return
    state.sessions[session.id] = {
      enabled: config.enabled === true,
      repository: config.repository,
      branch: resolveBranch(config),
      branchBase: config.branchBase || '',
      updateReadme: config.updateReadme === true,
      updatedAt: Date.now(),
      source: 'workspace',
    }
    await persist()
  }

  function publicPending(entry) {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      sessionTitle: entry.sessionTitle,
      turn: entry.turn,
      repository: entry.repository,
      branch: entry.branch,
      branchBase: entry.branchBase || '',
      files: entry.files,
      fileCount: entry.fileCount,
      stat: entry.stat,
      message: entry.message,
      manual: entry.manual === true,
      updateReadme: entry.updateReadme === true,
      createdAt: entry.createdAt,
      cwd: entry.cwd,
    }
  }

  function recordResult(result) {
    const entry = { id: randomUUID(), time: Date.now(), ...result }
    state.lastResults = [entry, ...state.lastResults].slice(0, MAX_RESULTS)
    void persist()
    return entry
  }

  function prunePending() {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (now - entry.createdAt > MAX_PENDING_MS) pending.delete(id)
    }
  }

  /* ---------------------------------------------------------------- */
  /* routes                                                           */
  /* ---------------------------------------------------------------- */

  function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  function ok(value = {}) {
    return json({ ok: true, ...value })
  }

  function fail(code, message, details) {
    return json({
      ok: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    })
  }

  async function bodyOf(request) {
    try {
      const value = await request.json()
      return asRecord(value) || {}
    } catch {
      return {}
    }
  }

  function route(suffix, handler) {
    const fetchRoute = service('connection')?.fetch
    if (fetchRoute === undefined || typeof fetchRoute.register !== 'function') return
    ctx.effect(() => fetchRoute.register({
      path: `${ROUTE_PREFIX}${suffix}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handler,
    }), `${PLUGIN}: route ${suffix}`)
  }

  async function handleState(request) {
    try {
      await stateReady
      prunePending()
      const body = await bodyOf(request)
      const registry = service('workspaceRegistry')
      const workspaces = registry === undefined ? [] : registry.list().map((workspace) => {
        const config = state.workspaces[workspace.id]
        return {
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          config: config === undefined ? null : {
            ...config,
            repository: expandRepository(config.repository, state.global.githubPrefix),
          },
        }
      })
      const sessionMap = {}
      for (const [id, config] of Object.entries(state.sessions)) {
        sessionMap[id] = {
          enabled: config.enabled === true,
          repository: expandRepository(config.repository || '', state.global.githubPrefix),
          branch: resolveBranch(config),
          branchBase: config.branchBase || '',
          updateReadme: config.updateReadme === true,
          source: config.source === 'workspace' ? 'workspace' : 'session',
        }
      }
      const result = {
        global: { ...state.global },
        workspaces,
        sessions: sessionMap,
        pending: [...pending.values()].map(publicPending),
        lastResults: state.lastResults,
        tokenConfigured: (await readToken()) !== undefined,
        revision: Date.now(),
      }
      if (typeof body.sessionId === 'string') {
        result.session = await resolveSessionConfig(body.sessionId)
      }
      return ok(result)
    } catch (error) {
      console.error(`[${PLUGIN}] state route failed:`, error)
      return fail('STATE_FAILED', error?.message || String(error))
    }
  }

  async function handleSessionState(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      const header = await sessionHeader(body.sessionId)
      const workspace = await workspaceForSession(body.sessionId, header?.cwd)
      return ok({
        config: await resolveSessionConfig(body.sessionId),
        workspace: workspace === undefined ? null : { id: workspace.id, title: workspace.title, path: workspace.path },
        session: header === undefined ? null : { createdAt: header.createdAt, cwd: header.cwd || '' },
        global: { ...state.global },
      })
    } catch (error) {
      console.error(`[${PLUGIN}] session route failed:`, error)
      return fail('SESSION_STATE_FAILED', error?.message || String(error))
    }
  }

  async function handleConfig(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const global = asRecord(body.global)
      // Validate the complete payload before touching in-memory state.
      const globalPatch = {}
      if (global !== null) {
        if (typeof global.userName === 'string') globalPatch.userName = global.userName.trim()
        if (typeof global.userEmail === 'string') globalPatch.userEmail = global.userEmail.trim()
        if (typeof global.requireConfirmation === 'boolean') globalPatch.requireConfirmation = global.requireConfirmation
        if (typeof global.askCreateMissingRepo === 'boolean') globalPatch.askCreateMissingRepo = global.askCreateMissingRepo
        if (typeof global.aiProvider === 'string') globalPatch.aiProvider = global.aiProvider.trim()
        if (typeof global.aiModel === 'string') globalPatch.aiModel = global.aiModel.trim()
        if (typeof global.defaultBranch === 'string') {
          const branch = global.defaultBranch.trim()
          if (branch !== '' && !validBranch(branch)) return fail('BRANCH_INVALID', `Invalid branch name: ${branch}`)
          if (branch !== '') globalPatch.defaultBranch = branch
        }
        if (typeof global.githubPrefix === 'string') {
          const prefix = normalizeGithubPrefix(global.githubPrefix)
          if (prefix === null) return fail('GITHUB_PREFIX_INVALID', 'The GitHub repository prefix must be an http(s) URL')
          globalPatch.githubPrefix = prefix
        }
      }

      const oldLogin = state.global.githubLogin
      const oldAutoPrefix = autoGithubPrefix(oldLogin)
      const requestedPrefix = globalPatch.githubPrefix === undefined
        ? state.global.githubPrefix
        : globalPatch.githubPrefix
      const prefixWasAuto = requestedPrefix === ''
        || requestedPrefix === 'https://github.com/'
        || requestedPrefix === oldAutoPrefix

      Object.assign(state.global, globalPatch)
      let githubUserError = null
      if (body.clearToken === true) {
        await clearToken()
        state.global.githubLogin = ''
        if (prefixWasAuto) state.global.githubPrefix = 'https://github.com/'
      } else if (typeof body.token === 'string' && body.token.trim() !== '') {
        const token = body.token.trim()
        await writeToken(token)
        try {
          const user = await fetchGitHubUser(token)
          state.global.githubLogin = user.login
          if (prefixWasAuto) state.global.githubPrefix = autoGithubPrefix(user.login)
        } catch (error) {
          githubUserError = error && error.message ? error.message : String(error)
          state.global.githubLogin = ''
        }
      }

      await persist()
      return ok({
        global: { ...state.global },
        tokenConfigured: (await readToken()) !== undefined,
        githubUserError,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] config route failed:`, error)
      return fail('CONFIG_FAILED', error?.message || String(error))
    }
  }

  async function maybeCheckRepo(repository, enabled, skipRepoCheck) {
    if (!enabled || skipRepoCheck === true || repository === '') return { warning: null, missing: null }
    if (state.global.askCreateMissingRepo !== true) return { warning: null, missing: null }
    const parsed = parseGitHubRepository(repository)
    if (parsed === null) return { warning: null, missing: null }
    const token = await readToken()
    if (token === undefined) return { warning: null, missing: null }
    try {
      const result = await checkGitHubRepo(token, parsed.owner, parsed.name)
      if (result.exists === true) return { warning: null, missing: null }
      return {
        warning: null,
        missing: {
          ...parsed,
          repository,
          canCreate: true,
          tokenConfigured: true,
        },
      }
    } catch (error) {
      return {
        warning: `Could not verify the GitHub repository: ${error && error.message ? error.message : String(error)}`,
        missing: null,
      }
    }
  }

  async function handleSession(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      if (body.reset === true) {
        delete state.sessions[body.sessionId]
        await persist()
        return ok({ config: await resolveSessionConfig(body.sessionId) })
      }
      const rawRepository = typeof body.repository === 'string' ? body.repository.trim() : ''
      if (isShortRepositoryName(rawRepository) && !githubPrefixHasAccount(state.global.githubPrefix)) {
        return fail('GITHUB_PREFIX_REQUIRED', 'Save a GitHub token or set a default repository prefix before using a short repository name')
      }
      const repository = expandRepository(rawRepository, state.global.githubPrefix)
      const enabled = body.enabled === true
      const previous = state.sessions[body.sessionId]
      const updateReadme = typeof body.updateReadme === 'boolean' ? body.updateReadme : previous?.updateReadme === true
      const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
      const branchBase = typeof body.branchBase === 'string' ? body.branchBase.trim() : (previous?.branchBase || '')
      if (enabled && repository === '') return fail('REPOSITORY_REQUIRED', 'Set a repository before enabling auto-commit')
      if (branch !== '' && !validBranch(branch)) return fail('BRANCH_INVALID', `Invalid branch name: ${branch}`)
      if (branchBase !== '' && !validBranch(branchBase)) return fail('BRANCH_INVALID', `Invalid base branch name: ${branchBase}`)
      if (branchBase !== '' && branchBase === (branch === '' ? state.global.defaultBranch : branch)) {
        return fail('BRANCH_BASE_INVALID', 'The new branch and its base branch must be different')
      }
      const check = await maybeCheckRepo(repository, enabled, body.skipRepoCheck === true)
      if (check.missing !== null) return fail('REPO_NOT_FOUND', 'The repository does not exist on GitHub', check.missing)
      state.sessions[body.sessionId] = {
        enabled,
        repository,
        branch: branch === '' ? state.global.defaultBranch : branch,
        branchBase,
        updateReadme,
        updatedAt: Date.now(),
        source: 'session',
      }
      await persist()
      return ok({
        config: resolvedSessionConfig(body.sessionId, state.sessions[body.sessionId], await workspaceForSession(body.sessionId), 'session'),
        repoCheckWarning: check.warning,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] session save failed:`, error)
      return fail('SESSION_SAVE_FAILED', error?.message || String(error))
    }
  }

  async function handleWorkspace(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.workspaceId !== 'string' || body.workspaceId === '') return fail('WORKSPACE_REQUIRED', 'workspaceId is required')
      const registry = service('workspaceRegistry')
      if (registry === undefined || registry.get(body.workspaceId) === undefined) {
        return fail('WORKSPACE_NOT_FOUND', 'This workspace no longer exists')
      }
      if (body.reset === true) {
        delete state.workspaces[body.workspaceId]
        await persist()
        return ok({ config: null })
      }
      const rawRepository = typeof body.repository === 'string' ? body.repository.trim() : ''
      if (isShortRepositoryName(rawRepository) && !githubPrefixHasAccount(state.global.githubPrefix)) {
        return fail('GITHUB_PREFIX_REQUIRED', 'Save a GitHub token or set a default repository prefix before using a short repository name')
      }
      const repository = expandRepository(rawRepository, state.global.githubPrefix)
      const enabled = body.enabled === true
      const previous = state.workspaces[body.workspaceId]
      const updateReadme = typeof body.updateReadme === 'boolean' ? body.updateReadme : previous?.updateReadme === true
      const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
      const branchBase = typeof body.branchBase === 'string' ? body.branchBase.trim() : (previous?.branchBase || '')
      if (enabled && repository === '') return fail('REPOSITORY_REQUIRED', 'A repository is required before enabling a workspace')
      if (branch !== '' && !validBranch(branch)) return fail('BRANCH_INVALID', `Invalid branch name: ${branch}`)
      if (branchBase !== '' && !validBranch(branchBase)) return fail('BRANCH_INVALID', `Invalid base branch name: ${branchBase}`)
      if (branchBase !== '' && branchBase === (branch === '' ? state.global.defaultBranch : branch)) {
        return fail('BRANCH_BASE_INVALID', 'The new branch and its base branch must be different')
      }
      if (!enabled && repository === '' && !updateReadme) {
        delete state.workspaces[body.workspaceId]
        await persist()
        return ok({ config: null })
      }
      const check = await maybeCheckRepo(repository, enabled, body.skipRepoCheck === true)
      if (check.missing !== null) return fail('REPO_NOT_FOUND', 'The repository does not exist on GitHub', check.missing)
      const config = {
        enabled,
        repository,
        branch: branch === '' ? state.global.defaultBranch : branch,
        branchBase,
        updateReadme,
        updatedAt: Date.now(),
      }
      state.workspaces[body.workspaceId] = config
      await persist()
      return ok({ config: { ...config }, repoCheckWarning: check.warning })
    } catch (error) {
      console.error(`[${PLUGIN}] workspace save failed:`, error)
      return fail('WORKSPACE_SAVE_FAILED', error?.message || String(error))
    }
  }

  async function handleGitHubCreateRepo(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const token = await readToken()
      if (token === undefined) return fail('TOKEN_REQUIRED', 'A GitHub token is required to create a repository')
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const owner = typeof body.owner === 'string' ? body.owner.trim() : ''
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return fail('REPO_NAME_INVALID', 'The repository name must be 1-100 letters, digits, dots, dashes, or underscores')
      if (owner !== '' && !/^[A-Za-z0-9._-]+$/.test(owner)) return fail('REPO_OWNER_INVALID', 'The owner must be a GitHub user or organization name')
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (description.length > 350) return fail('REPO_DESCRIPTION_INVALID', 'The description must be at most 350 characters')
      const payload = {
        owner,
        name,
        description,
        private: body.private === true,
        autoInit: body.autoInit === true,
        hasIssues: body.hasIssues !== false,
        hasProjects: body.hasProjects !== false,
        hasWiki: body.hasWiki !== false,
        gitignoreTemplate: typeof body.gitignoreTemplate === 'string' ? body.gitignoreTemplate.trim() : '',
        licenseTemplate: typeof body.licenseTemplate === 'string' ? body.licenseTemplate.trim() : '',
        homepage: typeof body.homepage === 'string' ? body.homepage.trim() : '',
      }
      let data
      try {
        data = await createGitHubRepo(token, payload, state.global.githubLogin)
      } catch (error) {
        if (error.status === 401) return fail('GITHUB_AUTH_FAILED', 'GitHub rejected the token; save a valid token in Git settings')
        if (error.status === 422) return fail('GITHUB_VALIDATION_FAILED', error.message, error.data && error.data.errors)
        return fail('GITHUB_CREATE_FAILED', error && error.message ? error.message : String(error), { status: error && error.status })
      }
      if (state.global.githubLogin === '') {
        try {
          const user = await fetchGitHubUser(token)
          state.global.githubLogin = user.login
          if (state.global.githubPrefix === 'https://github.com/') state.global.githubPrefix = autoGithubPrefix(user.login)
          await persist()
        } catch {
          // The created repo is already enough; identity can be filled in later.
        }
      }
      // When the caller names the session or workspace, make the local folder a
      // real git repository right away. The creation flow is also used for a
      // proactively created repository, not just for one detected as missing.
      let repositoryInitialized = false
      let initWarning = null
      try {
        const project = await projectFromBody(body)
        if (project !== null && typeof project.cwd === 'string' && project.cwd !== '') {
          const projectBranch = project.branch || state.global.defaultBranch || 'main'
          repositoryInitialized = await ensureRepoRoot(project.cwd, projectBranch)
        }
      } catch (error) {
        initWarning = error?.message || String(error)
      }
      return ok({
        repo: {
          htmlUrl: data.html_url,
          cloneUrl: data.clone_url,
          sshUrl: data.ssh_url,
          fullName: data.full_name,
          private: data.private === true,
          defaultBranch: data.default_branch || '',
        },
        repositoryInitialized,
        initWarning,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] GitHub create-repo failed:`, error)
      return fail('GITHUB_CREATE_FAILED', error?.message || String(error))
    }
  }

  function aiSelection() {
    const provider = state.global.aiProvider.trim()
    const model = state.global.aiModel.trim()
    if (provider !== '') {
      return model === '' ? null : { provider, model, source: 'configured' }
    }
    try {
      const selection = service('agentDefaultModel')?.currentSelection()
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, source: 'default' }
      }
    } catch {
      // The default model service is optional in some profiles.
    }
    return null
  }

  function commitAiSelection(session) {
    const provider = state.global.aiProvider.trim()
    const model = state.global.aiModel.trim()
    if (provider !== '' && model !== '') return { provider, model, source: 'configured' }
    try {
      const header = session.requestHeader()
      if (typeof header?.config?.provider === 'string' && typeof header?.config?.model === 'string') {
        return { provider: header.config.provider, model: header.config.model, source: 'session' }
      }
    } catch {
      // Request headers are advisory here.
    }
    try {
      const selection = service('agentDefaultModel')?.currentSelection()
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, source: 'default' }
      }
    } catch {
      // The default model service is optional in some profiles.
    }
    return null
  }

  async function projectPathFor(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId !== '') {
      const live = service('sessions')?.get(sessionId)
      if (live !== undefined) {
        try {
          return service('workingDirectory')?.get(live) || live.header.cwd
        } catch {
          return live.header.cwd
        }
      }
      const header = await sessionHeader(sessionId)
      if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    if (workspaceId !== '') {
      const workspace = service('workspaceRegistry')?.get(workspaceId)
      if (workspace !== undefined) return workspace.path
    }
    return undefined
  }

  async function handleAiModels(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const llm = service('llm')
      if (llm === undefined) return fail('AI_UNAVAILABLE', 'The LLM service is unavailable in this profile')
      let providers = []
      try {
        providers = llm.listProviders()
      } catch (error) {
        return fail('AI_PROVIDERS_FAILED', error?.message || String(error))
      }
      providers = Array.isArray(providers) ? providers : []
      const requested = typeof body.provider === 'string' ? body.provider.trim() : ''
      let provider = requested
      if (provider === '') provider = state.global.aiProvider || (aiSelection()?.provider || '')
      if (provider === '' && providers.length > 0) provider = providers[0].id
      let models = []
      let error = null
      if (provider !== '' && typeof llm.listModels === 'function') {
        try {
          const list = await withTimeout(llm.listModels(provider), 10000, 'Timed out while loading models')
          models = (Array.isArray(list) ? list : []).map((item) => ({
            id: String(item.id),
            name: typeof item.name === 'string' && item.name !== '' ? item.name : String(item.id),
            description: typeof item.description === 'string' ? item.description : '',
          }))
        } catch (listError) {
          error = listError && listError.message ? listError.message : String(listError)
        }
      }
      return ok({
        providers: providers.map((item) => ({ id: item.id, name: item.name || item.id })),
        provider,
        models,
        selected: { provider: state.global.aiProvider, model: state.global.aiModel },
        error,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] ai/models route failed:`, error)
      return fail('AI_MODELS_FAILED', error?.message || String(error))
    }
  }

  async function handleDescribeProject(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const selection = aiSelection()
      if (selection === null) return fail('AI_MODEL_REQUIRED', 'Choose an AI provider and model in Git settings, or configure an agent default model')
      const llm = service('llm')
      if (llm === undefined) return fail('AI_UNAVAILABLE', 'The LLM service is unavailable in this profile')
      const cwd = await projectPathFor(body)
      if (cwd === undefined) return fail('PROJECT_NOT_FOUND', 'The session or workspace project directory is unavailable')
      const profile = await collectProjectProfile(cwd)
      const language = typeof body.language === 'string' && body.language.startsWith('zh') ? 'Simplified Chinese' : 'English'
      const sections = [
        `Project folder: ${profile.folder}`,
        profile.metadata.length > 0 ? `Project metadata:\n${profile.metadata.join('\n\n')}` : '',
        profile.topLevel.length > 0 ? `Top-level files: ${profile.topLevel.join(', ')}` : '',
        profile.nested.length > 0 ? `Notable files in conventional source directories: ${profile.nested.join(', ')}` : '',
        profile.samples.length > 0 ? `Source samples:\n${profile.samples.map((sample) => `--- ${sample.file} ---\n${sample.text}`).join('\n\n')}` : '',
        profile.readme !== '' ? `README excerpt:\n${profile.readme}` : '',
        'Write the GitHub repository description now.',
      ].filter(Boolean).join('\n\n')
      const prompt = truncate(sections, 18000)
      const system = [
        'You write a concise GitHub repository description for a software project.',
        'Return ONLY the description: one or two natural sentences, no markdown, no quotes, no labels.',
        `Write it in ${language}.`,
        'Describe the product purpose and the main technology or feature; do not list every file.',
        'Maximum 350 characters.',
      ].join('\n')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 25000)
      try {
        let text = ''
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          temperature: 0.3,
          maxTokens: 300,
          signal: controller.signal,
          purpose: 'git-repo-description',
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            throw new Error(chunk.reason?.failure?.message || 'The model did not finish the description')
          }
        }
        const description = cleanAiDescription(text)
        if (description === '') return fail('AI_DESCRIBE_EMPTY', 'The model returned an empty description')
        return ok({
          description,
          provider: selection.provider,
          model: selection.model,
          project: profile.folder,
        })
      } catch (error) {
        return fail('AI_DESCRIBE_FAILED', error?.message || String(error))
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      console.error(`[${PLUGIN}] ai/describe route failed:`, error)
      return fail('AI_DESCRIBE_FAILED', error?.message || String(error))
    }
  }

  async function handlePending(request) {
    try {
      await stateReady
      prunePending()
      const body = await bodyOf(request)
      const entry = typeof body.id === 'string' ? pending.get(body.id) : undefined
      if (entry === undefined) return fail('PENDING_NOT_FOUND', 'This commit proposal is no longer available')
      if (body.action === 'cancel') {
        pending.delete(entry.id)
        recordResult({ status: 'cancelled', sessionId: entry.sessionId, repository: entry.repository, branch: entry.branch, files: entry.fileCount })
        return ok({ status: 'cancelled' })
      }
      if (body.action !== 'commit') return fail('ACTION_INVALID', 'action must be commit or cancel')
      const message = normalizeCommitMessage(body.message === undefined ? entry.message : body.message)
      if (message === '') return fail('MESSAGE_REQUIRED', 'The commit message cannot be empty')
      let result
      try {
        result = await commitAndPush(entry, message)
      } catch (error) {
        result = {
          status: 'commit-failed',
          sessionId: entry.sessionId,
          repository: entry.repository,
          branch: entry.branch,
          error: error?.message || String(error),
        }
      }
      pending.delete(entry.id)
      recordResult(result)
      return ok({ status: result.status, result })
    } catch (error) {
      console.error(`[${PLUGIN}] pending decision failed:`, error)
      return fail('COMMIT_FAILED', error?.message || String(error))
    }
  }

  async function handleGitBranches(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const project = await projectFromBody(body)
      if (project === null) return fail('PROJECT_REQUIRED', 'sessionId or workspaceId is required')
      let repository = project.repository
      if (typeof body.repository === 'string') {
        const raw = body.repository.trim()
        repository = raw === '' ? '' : expandRepository(raw, state.global.githubPrefix)
      }
      const catalog = await branchCatalogFor(project.cwd, repository)
      return ok({ ...catalog, repository })
    } catch (error) {
      console.error(`[${PLUGIN}] git/branches failed:`, error)
      return fail('GIT_BRANCHES_FAILED', error?.message || String(error))
    }
  }

  async function handleGitGraph(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      const project = await projectForSession(body.sessionId)
      if (project === null) return fail('SESSION_NOT_FOUND', 'This session is no longer available')
      if (!(await isRepoRoot(project.cwd))) return fail('GIT_NOT_REPO', 'The session workspace is not a git repository yet')
      const readLines = async () => {
        try {
          const { stdout } = await runGit([
            'log', '--all', '--graph', '--no-color', '--date=short',
            '--pretty=format:%H%x1f%P%x1f%h%x1f%s%x1f%d%x1f%an%x1f%ad',
            '-n', '1000',
          ], project.cwd)
          return parseGitGraphLog(stdout)
        } catch (error) {
          const text = error?.message || String(error)
          if (/does not have any commits|bad default revision|unknown revision|ambiguous argument 'HEAD'/i.test(text)) return []
          throw error
        }
      }
      // Read the local graph first; only rebuild it if the remote moved.
      let lines = await readLines()
      let remoteInfo = null
      if (project.repository !== '') {
        remoteInfo = await readRemoteBranches(project.repository, project.cwd)
        if (remoteInfo.updated === true) lines = await readLines()
      }
      const catalog = await branchCatalogFor(project.cwd, project.repository, remoteInfo)
      let currentCommit = ''
      try {
        currentCommit = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      } catch {
        currentCommit = ''
      }
      return ok({
        lines,
        currentCommit,
        current: catalog.current,
        defaultBranch: catalog.defaultBranch,
        branches: catalog.branches,
        repository: project.repository,
        warning: catalog.warning,
        updated: catalog.updated,
        remoteChecked: catalog.remoteChecked,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] git/graph failed:`, error)
      return fail('GIT_GRAPH_FAILED', error?.message || String(error))
    }
  }

  async function handleGitRollback(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      const project = await projectForSession(body.sessionId)
      if (project === null) return fail('SESSION_NOT_FOUND', 'This session is no longer available')
      if (!(await isRepoRoot(project.cwd))) return fail('GIT_NOT_REPO', 'The session workspace is not a git repository yet')
      try {
        await requireCleanWorktree(project.cwd)
      } catch (error) {
        return fail('WORKTREE_DIRTY', error.message, { files: error.files })
      }
      const selected = typeof body.commit === 'string' ? body.commit.trim() : ''
      if (!/^[0-9a-f]{7,40}$/i.test(selected)) return fail('COMMIT_INVALID', 'Select a commit from the graph')
      let resolved
      try {
        resolved = (await runGit(['rev-parse', '--verify', `${selected}^{commit}`], project.cwd)).stdout.trim()
      } catch {
        return fail('COMMIT_NOT_FOUND', 'That commit is not available in this repository')
      }
      const head = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      if (resolved === head) return fail('NO_CHANGES', 'The project already matches that commit')
      const patch = (await runGit(['diff', '--binary', 'HEAD', resolved], project.cwd)).stdout
      if (patch.trim() === '') return fail('NO_CHANGES', 'That commit has the same tree as HEAD')
      try {
        await runGitInput(['apply', '--index', '--whitespace=nowarn', '-'], project.cwd, patch)
      } catch (error) {
        try { await runGit(['reset', '--hard', 'HEAD'], project.cwd) } catch { /* best effort */ }
        return fail('ROLLBACK_APPLY_FAILED', error?.message || String(error))
      }
      let selectedSubject = ''
      try {
        selectedSubject = (await runGit(['log', '-1', '--format=%s', resolved], project.cwd)).stdout.trim()
      } catch {
        selectedSubject = ''
      }
      const fallback = `revert: restore ${resolved.slice(0, 7)}${selectedSubject === '' ? '' : ` ${selectedSubject}`}`
      const message = normalizeCommitMessage(
        typeof body.message === 'string' && body.message.trim() !== '' ? body.message : fallback,
      )
      if (message === '') return fail('MESSAGE_REQUIRED', 'The rollback commit message cannot be empty')
      const split = splitCommitMessage(message)
      try {
        await runGit([
          ...commitAuthorArgs(),
          'commit',
          '-m', split.subject,
          ...(split.body === '' ? [] : ['-m', split.body]),
        ], project.cwd)
      } catch (error) {
        return fail('COMMIT_FAILED', error?.message || String(error))
      }
      const commit = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      const result = {
        status: 'committed',
        sessionId: body.sessionId,
        repository: project.repository,
        branch: project.branch,
        commit,
        subject: split.subject,
        restoredFrom: resolved,
        previousHead: head,
      }
      if (body.push !== false && project.repository !== '') {
        try {
          await pushRef(project.cwd, project.repository, `HEAD:${project.branch}`)
          result.status = 'pushed'
          result.pushed = true
        } catch (error) {
          result.status = 'push-failed'
          result.pushed = false
          result.error = error?.message || String(error)
          result.recovery = `The rollback commit ${commit.slice(0, 12)} is local. Fix the remote/token and push it manually.`
        }
      }
      return ok(result)
    } catch (error) {
      console.error(`[${PLUGIN}] git/rollback failed:`, error)
      return fail('GIT_ROLLBACK_FAILED', error?.message || String(error))
    }
  }

  async function handleGitMerge(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.workspaceId !== 'string' || body.workspaceId === '') return fail('WORKSPACE_REQUIRED', 'workspaceId is required')
      const project = await projectForWorkspace(body.workspaceId)
      if (project === null) return fail('WORKSPACE_NOT_FOUND', 'This workspace no longer exists')
      if (!(await isRepoRoot(project.cwd))) return fail('GIT_NOT_REPO', 'The workspace is not a git repository')
      const source = typeof body.source === 'string' ? body.source.trim() : ''
      if (source === '' || !validBranch(source)) return fail('BRANCH_INVALID', 'Choose a valid source branch')
      try {
        await requireCleanWorktree(project.cwd)
      } catch (error) {
        return fail('WORKTREE_DIRTY', error.message, { files: error.files })
      }
      const current = await currentBranchOf(project.cwd)
      if (current === '') return fail('DETACHED_HEAD', 'Check out a branch before merging')
      if (source === current) return fail('BRANCH_SAME', 'Choose a branch other than the current branch')
      let sourceCommit
      try {
        sourceCommit = await resolveBranchCommit(project.cwd, project.repository, source)
      } catch (error) {
        return fail('BRANCH_NOT_FOUND', `Cannot resolve ${source}: ${error?.message || String(error)}`)
      }
      const before = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      try {
        await runGit([
          ...commitAuthorArgs(),
          'merge', '--no-edit',
          '-m', `merge: ${source} into ${current}`,
          sourceCommit,
        ], project.cwd)
      } catch (error) {
        const conflicts = await unmergedFiles(project.cwd)
        try { await runGit(['merge', '--abort'], project.cwd) } catch { /* best effort */ }
        return fail('MERGE_CONFLICT', error?.message || String(error), { files: conflicts })
      }
      const after = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      const result = {
        status: before === after ? 'up-to-date' : 'merged',
        repository: project.repository,
        current,
        source,
        before,
        after,
        merged: before !== after,
      }
      await attachPushResult(result, project, current, body.push !== false)
      return ok(result)
    } catch (error) {
      console.error(`[${PLUGIN}] git/merge failed:`, error)
      return fail('GIT_MERGE_FAILED', error?.message || String(error))
    }
  }

  async function handleGitRebase(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.workspaceId !== 'string' || body.workspaceId === '') return fail('WORKSPACE_REQUIRED', 'workspaceId is required')
      const project = await projectForWorkspace(body.workspaceId)
      if (project === null) return fail('WORKSPACE_NOT_FOUND', 'This workspace no longer exists')
      if (!(await isRepoRoot(project.cwd))) return fail('GIT_NOT_REPO', 'The workspace is not a git repository')
      const onto = typeof body.onto === 'string' ? body.onto.trim() : ''
      if (onto === '' || !validBranch(onto)) return fail('BRANCH_INVALID', 'Choose a valid target branch')
      try {
        await requireCleanWorktree(project.cwd)
      } catch (error) {
        return fail('WORKTREE_DIRTY', error.message, { files: error.files })
      }
      const current = await currentBranchOf(project.cwd)
      if (current === '') return fail('DETACHED_HEAD', 'Check out a branch before rebasing')
      if (onto === current) return fail('BRANCH_SAME', 'Choose a branch other than the current branch')
      let ontoCommit
      try {
        ontoCommit = await resolveBranchCommit(project.cwd, project.repository, onto)
      } catch (error) {
        return fail('BRANCH_NOT_FOUND', `Cannot resolve ${onto}: ${error?.message || String(error)}`)
      }
      const before = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      try {
        await runGit([...commitAuthorArgs(), 'rebase', ontoCommit], project.cwd)
      } catch (error) {
        const conflicts = await unmergedFiles(project.cwd)
        try { await runGit(['rebase', '--abort'], project.cwd) } catch { /* best effort */ }
        return fail('REBASE_CONFLICT', error?.message || String(error), { files: conflicts })
      }
      const after = (await runGit(['rev-parse', 'HEAD'], project.cwd)).stdout.trim()
      const result = {
        status: before === after ? 'up-to-date' : 'rebased',
        repository: project.repository,
        current,
        onto,
        before,
        after,
        rebased: before !== after,
      }
      await attachPushResult(result, project, current, body.push !== false)
      return ok(result)
    } catch (error) {
      console.error(`[${PLUGIN}] git/rebase failed:`, error)
      return fail('GIT_REBASE_FAILED', error?.message || String(error))
    }
  }

  async function sessionTitleFor(sessionId) {
    try {
      const query = service('sessionQuery')
      if (typeof query?.readTitle === 'function') {
        const snapshot = await query.readTitle(sessionId)
        if (typeof snapshot?.title === 'string' && snapshot.title !== '') return snapshot.title
      }
    } catch {
      // The title is decorative only.
    }
    return ''
  }

  async function syncStatusFor(project) {
    const cwd = project.cwd
    const branch = project.branch || state.global.defaultBranch || 'main'
    const repository = project.repository
    const result = {
      sessionId: project.sessionId,
      repository,
      branch,
      repo: false,
      localHead: '',
      remoteHead: null,
      dirty: false,
      files: [],
      fileCount: 0,
      ahead: null,
      behind: null,
      inSync: false,
      outOfSync: false,
      remoteChecked: false,
      updated: false,
      warning: null,
      canManual: repository !== '' && branch !== '',
      pending: false,
      lastFailure: null,
    }
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        result.repo = await isRepoRoot(cwd)
      } catch {
        result.repo = false
      }
      if (result.repo) {
        try {
          result.localHead = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim()
        } catch {
          result.localHead = ''
        }
        try {
          const status = await runGit(['status', '--porcelain=v1', '-uall', '--', '.'], cwd)
          result.files = parseStatusFiles(status.stdout).slice(0, 50)
          result.fileCount = result.files.length
          result.dirty = result.files.length > 0
        } catch {
          result.files = []
          result.fileCount = 0
          result.dirty = false
        }
      }
    }
    if (repository !== '') {
      try {
        // The sync indicator only needs the remote head. It deliberately does
        // not fetch: branch/graph views perform the local-first update, while
        // this check stays fast and read-only.
        const snapshot = await readRemoteSnapshot(repository, cwd)
        result.remoteChecked = snapshot.heads !== null
        result.warning = snapshot.warning || null
        if (snapshot.heads !== null) result.remoteHead = snapshot.heads.get(branch) || null
      } catch (error) {
        result.warning = `Could not check the remote branch: ${error?.message || String(error)}`
      }
    }
    let different = false
    if (result.remoteChecked) {
      if (result.localHead === '') different = result.remoteHead !== null
      else if (result.remoteHead === null) different = true
      else different = result.localHead !== result.remoteHead
    }
    result.outOfSync = result.dirty || different || (!result.repo && result.canManual)
    result.inSync = result.remoteChecked && !result.outOfSync && result.localHead !== '' && result.localHead === result.remoteHead
    if (result.localHead !== '' && result.remoteHead !== null && result.repo) {
      try {
        await runGit(['cat-file', '-e', `${result.remoteHead}^{commit}`], cwd)
        const count = await runGit(['rev-list', '--left-right', '--count', `${result.localHead}...${result.remoteHead}`], cwd)
        const parts = count.stdout.trim().split(/\s+/).map((value) => Number(value))
        if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
          result.ahead = parts[0]
          result.behind = parts[1]
        }
      } catch {
        // The remote commit is not available locally; counts stay unknown.
      }
    }
    result.pending = [...pending.values()].some((entry) => entry.sessionId === project.sessionId)
    const latest = state.lastResults.find((item) => item.sessionId === project.sessionId)
    if (latest !== undefined && ['push-failed', 'commit-failed', 'error'].includes(latest.status)) {
      result.lastFailure = {
        status: latest.status,
        time: latest.time,
        error: latest.error || '',
        recovery: latest.recovery || '',
        commit: latest.commit || '',
      }
    }
    return result
  }

  async function pushExistingCommits(project) {
    const cwd = project.cwd
    const branch = project.branch
    const base = {
      sessionId: project.sessionId,
      repository: project.repository,
      branch,
      manual: true,
      pushedOnly: true,
      files: 0,
    }
    if (!(await isRepoRoot(cwd))) {
      return { ...base, status: 'no-changes', pushed: false }
    }
    if (project.branchBase) {
      const remoteUrl = await prepareRemote(cwd, project.repository)
      const token = await readToken()
      await ensureNewBranch(cwd, remoteUrl, branch, project.branchBase, token)
    }
    let head = ''
    try {
      head = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim()
    } catch {
      head = ''
    }
    if (head === '') return { ...base, status: 'no-changes', pushed: false }
    const remoteUrl = await prepareRemote(cwd, project.repository)
    const token = await readToken()
    const env = pushEnvironment(remoteUrl, token)
    try {
      await runGit(['push', remoteUrl, `HEAD:${branch}`], cwd, env)
      return { ...base, status: 'pushed', pushed: true, commit: head }
    } catch (pushError) {
      if (!isNonFastForwardPush(pushError)) {
        return {
          ...base,
          status: 'push-failed',
          pushed: false,
          commit: head,
          error: pushError?.message || String(pushError),
          recovery: `The local commits remain. Fix the remote/token and retry the push.`,
        }
      }
      try {
        const mergeCommit = await reconcileRemote(cwd, remoteUrl, branch, token, commitAuthorArgs())
        await runGit(['push', remoteUrl, `HEAD:${branch}`], cwd, env)
        return {
          ...base,
          status: 'pushed',
          pushed: true,
          mergedRemote: true,
          mergeCommit,
          commit: mergeCommit,
        }
      } catch (mergeError) {
        return {
          ...base,
          status: 'push-failed',
          pushed: false,
          commit: head,
          error: mergeError?.message || String(mergeError),
          recovery: `The local commits remain and the remote could not be reconciled automatically.`,
        }
      }
    }
  }

  async function handleGitRepoStatus(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      const project = await projectFromBody(body)
      if (project === null) return fail('PROJECT_REQUIRED', 'sessionId or workspaceId is required')
      let repo = false
      try {
        repo = await isRepoRoot(project.cwd)
      } catch {
        repo = false
      }
      return ok({
        repo,
        repository: project.repository,
        branch: project.branch,
        branchBase: project.branchBase || '',
        cwd: project.cwd,
      })
    } catch (error) {
      console.error(`[${PLUGIN}] git/repo-status failed:`, error)
      return fail('GIT_REPO_STATUS_FAILED', error?.message || String(error))
    }
  }

  async function handleGitSync(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      const project = await projectForSession(body.sessionId)
      if (project === null) return fail('SESSION_NOT_FOUND', 'This session is no longer available')
      return ok(await syncStatusFor(project))
    } catch (error) {
      console.error(`[${PLUGIN}] git/sync failed:`, error)
      return fail('GIT_SYNC_FAILED', error?.message || String(error))
    }
  }

  async function handleGitManualCommit(request) {
    try {
      await stateReady
      const body = await bodyOf(request)
      if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('SESSION_REQUIRED', 'sessionId is required')
      const project = await projectForSession(body.sessionId)
      if (project === null) return fail('SESSION_NOT_FOUND', 'This session is no longer available')
      if (project.repository === '' || project.branch === '') {
        return fail('REPOSITORY_REQUIRED', 'Set a repository and branch before a manual commit')
      }
      if ([...pending.values()].some((entry) => entry.sessionId === project.sessionId)) {
        return fail('PENDING_EXISTS', 'A commit proposal is already waiting for confirmation')
      }
      const changes = await inspectChanges(project.cwd, project.branch)
      if (changes.files.length === 0) {
        const result = await pushExistingCommits(project)
        recordResult(result)
        return ok({ mode: 'push', status: result.status, result })
      }
      const session = project.session ?? service('sessions')?.get(project.sessionId) ?? null
      const ai = commitAiSelection(session)
      const context = {
        turn: 0,
        manual: true,
        language: body.language === 'zh' ? 'zh' : body.language === 'en' ? 'en' : undefined,
        userRequest: '',
        assistantSummary: '',
        touched: [],
        files: changes.files,
        stat: changes.stat,
        diff: changes.diff,
        untrackedSamples: changes.untrackedSamples,
        toolNames: [],
        sessionTitle: await sessionTitleFor(project.sessionId),
      }
      const message = await generateCommitMessage(session, context, ai)
      const entry = {
        id: randomUUID(),
        sessionId: project.sessionId,
        sessionTitle: context.sessionTitle,
        turn: 0,
        manual: true,
        cwd: project.cwd,
        repository: project.repository,
        branch: project.branch,
        branchBase: project.branchBase || '',
        files: changes.files.slice(0, 200),
        fileCount: changes.files.length,
        stat: changes.stat,
        message,
        updateReadme: project.config.updateReadme === true,
        ai,
        turnContext: context,
        createdAt: Date.now(),
      }
      if (state.global.requireConfirmation) {
        pending.set(entry.id, entry)
        return ok({ mode: 'proposed', status: 'proposed', pendingId: entry.id })
      }
      const result = await commitAndPush(entry, message)
      recordResult(result)
      return ok({ mode: 'commit', status: result.status, result })
    } catch (error) {
      console.error(`[${PLUGIN}] git/manual-commit failed:`, error)
      return fail('GIT_MANUAL_COMMIT_FAILED', error?.message || String(error))
    }
  }

  route('/state', handleState)
  route('/session-state', handleSessionState)
  route('/config', handleConfig)
  route('/session', handleSession)
  route('/workspace', handleWorkspace)
  route('/github/create-repo', handleGitHubCreateRepo)
  route('/ai/models', handleAiModels)
  route('/ai/describe', handleDescribeProject)
  route('/pending', handlePending)
  route('/git/repo-status', handleGitRepoStatus)
  route('/git/branches', handleGitBranches)
  route('/git/graph', handleGitGraph)
  route('/git/rollback', handleGitRollback)
  route('/git/merge', handleGitMerge)
  route('/git/rebase', handleGitRebase)
  route('/git/sync', handleGitSync)
  route('/git/manual-commit', handleGitManualCommit)

  /* ---------------------------------------------------------------- */
  /* turn trigger                                                     */
  /* ---------------------------------------------------------------- */

  ctx.effect(() => ctx.on('session/created', (session) => {
    void snapshotWorkspaceDefault(session).catch((error) => {
      console.error(`[${PLUGIN}] workspace snapshot failed:`, error)
    })
  }), `${PLUGIN}: session created`)

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'turn/end') return
    if (event.data?.reason?.kind !== 'completed') return
    if (session.header.origin === 'subagent') return
    enqueueTurn(session, event.data.turn)
  }), `${PLUGIN}: turn end`)

  function enqueueTurn(session, turn) {
    const id = session.id
    const previous = sessionQueues.get(id) || Promise.resolve()
    const next = previous
      .then(() => runTurnCommit(session, turn))
      .catch((error) => {
        console.error(`[${PLUGIN}] turn commit failed:`, error)
        recordResult({ status: 'error', sessionId: id, error: error?.message || String(error) })
      })
      .finally(() => {
        if (sessionQueues.get(id) === next) sessionQueues.delete(id)
      })
    sessionQueues.set(id, next)
  }

  async function runTurnCommit(session, turn) {
    await stateReady
    const config = await resolveSessionConfig(session.id)
    if (!config.enabled || config.repository === '') return
    const cwd = service('workingDirectory')?.get(session) || session.header.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      recordResult({ status: 'error', sessionId: session.id, error: 'The session has no working directory' })
      return
    }
    let changes
    try {
      changes = await inspectChanges(cwd, config.branch)
    } catch (error) {
      recordResult({ status: 'error', sessionId: session.id, repository: config.repository, branch: config.branch, error: error?.message || String(error) })
      return
    }
    if (changes.files.length === 0) return

    const context = await collectTurnContext(session, turn, changes)
    const ai = commitAiSelection(session)
    const message = await generateCommitMessage(session, context, ai)
    const id = randomUUID()
    const entry = {
      id,
      sessionId: session.id,
      sessionTitle: context.sessionTitle,
      turn,
      cwd,
      repository: config.repository,
      branch: config.branch,
      branchBase: config.branchBase || '',
      files: changes.files.slice(0, 200),
      fileCount: changes.files.length,
      stat: changes.stat,
      message,
      updateReadme: config.updateReadme === true,
      ai,
      turnContext: context,
      createdAt: Date.now(),
    }

    if (state.global.requireConfirmation) {
      pending.set(id, entry)
      return
    }
    const result = await commitAndPush(entry, message)
    recordResult(result)
  }

  async function collectTurnContext(session, turn, changes) {
    let events = []
    try {
      events = session.ownEvents()
    } catch {
      events = []
    }
    let userRequest = ''
    let assistantSummary = ''
    const toolNames = new Set()
    const touched = new Set()
    let sessionTitle = ''
    for (const event of events) {
      if (event.type === 'user/message') {
        const text = messageText(event.data?.message)
        if (text.trim() !== '') userRequest = text.trim()
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data?.message)
        if (text.trim() !== '') assistantSummary = text.trim()
      }
      if (event.type === 'tool/call' && event.data?.turn === turn) {
        const name = String(event.data.name || '')
        if (name !== '') toolNames.add(name)
        for (const guess of pathArguments(parseToolArguments(event.data.arguments))) touched.add(guess)
      }
    }
    try {
      const sessionQuery = service('sessionQuery')
      if (typeof sessionQuery?.readTitle === 'function') {
        const snapshot = await sessionQuery.readTitle(session.id)
        if (snapshot?.title) sessionTitle = snapshot.title
      }
    } catch {
      // Title is decorative only.
    }
    return {
      turn,
      userRequest: truncate(userRequest, 3000),
      assistantSummary: truncate(assistantSummary, 3000),
      touched: [...touched].slice(0, 100),
      files: changes.files,
      stat: changes.stat,
      diff: changes.diff,
      untrackedSamples: changes.untrackedSamples,
      toolNames: [...toolNames],
      sessionTitle,
    }
  }

  async function generateCommitMessage(session, context, selection) {
    const fallback = fallbackCommitMessage(context)
    const llm = service('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return fallback
    const ai = selection === undefined ? commitAiSelection(session) : selection
    if (ai === null) return fallback
    const provider = ai.provider
    const model = ai.model
    const chinese = isCjkText(context.userRequest || context.assistantSummary)
    const language = context.language === 'zh'
      ? 'Chinese (简体中文)'
      : context.language === 'en'
        ? 'English'
        : chinese ? 'Chinese (简体中文)' : 'English'
    const system = [
      'You write git commit messages for an AI coding agent.',
      'Return ONLY the commit message — no explanation, no code fence, no quotes.',
      'Use the Conventional Commits format: type(optional scope): short imperative summary.',
      'The subject line must be at most 72 characters. Add a blank line and a concise body with 2-5 bullet points when the change is non-trivial.',
      `Write the message in ${language}.`,
      'Describe the intent and the important files/behavior, not a raw list of diffs.',
    ].join('\n')
    const diffText = [
      context.stat ? `Diff stat:\n${context.stat}` : '',
      context.diff ? `Diff excerpt:\n${context.diff}` : '',
      context.untrackedSamples.length > 0
        ? `New file excerpts:\n${context.untrackedSamples.map((item) => `--- ${item.file} ---\n${item.sample}`).join('\n\n')}`
        : '',
    ].filter(Boolean).join('\n\n')
    const prompt = [
      context.manual
        ? 'This is a manual retry commit requested from Git settings. Describe the current uncommitted changes carefully.'
        : `This message belongs to one completed coding turn (#${context.turn}).`,
      context.userRequest ? `User request:\n${context.userRequest}` : '',
      context.assistantSummary ? `Agent's own summary of the turn:\n${context.assistantSummary}` : '',
      `Changed files (git status):\n${context.files.slice(0, 120).map((file) => `- ${file}`).join('\n')}`,
      context.touched.length > 0 ? `Files the agent touched through tools:\n${context.touched.map((file) => `- ${file}`).join('\n')}` : '',
      diffText,
    ].filter(Boolean).join('\n\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider,
        model,
        temperature: 0.2,
        maxTokens: 700,
        signal: controller.signal,
        purpose: 'git-auto-commit',
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(chunk.reason?.failure?.message || 'The model did not finish the commit message')
        }
      }
      const normalized = normalizeCommitMessage(text)
      return normalized === '' ? fallback : normalized
    } catch (error) {
      console.warn(`[${PLUGIN}] commit message generation fell back:`, error?.message || error)
      return fallback
    } finally {
      clearTimeout(timer)
    }
  }

  function fallbackCommitMessage(context) {
    const files = context.files
    const count = files.length
    const hint = firstLine(context.userRequest || context.assistantSummary || '', 56)
    const subject = hint !== ''
      ? `chore: ${hint}`
      : `chore: update ${count} file${count === 1 ? '' : 's'}`
    const bullets = files.slice(0, 12).map((file) => `- ${file}`)
    return bullets.length === 0 ? subject : `${subject}\n\n${bullets.join('\n')}`
  }

  function readmeFields(readme) {
    if (readme === null || readme === undefined) return {}
    return {
      readmeStatus: readme.status,
      ...(readme.file ? { readmeFile: readme.file } : {}),
      ...(readme.warning ? { readmeWarning: readme.warning } : {}),
    }
  }

  async function generateReadmeUpdate(entry, message) {
    if (entry.ai === null || entry.ai === undefined) {
      return { status: 'skipped', warning: 'No AI model is configured, so the README was not updated.' }
    }
    const llm = service('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      return { status: 'skipped', warning: 'The AI service is unavailable, so the README was not updated.' }
    }
    let readme
    try {
      readme = await readProjectReadme(entry.cwd)
    } catch (error) {
      return { status: 'failed', warning: `Could not read the README: ${error?.message || String(error)}` }
    }
    if (readme.content === null) {
      return { status: 'skipped', file: readme.name, warning: `The README is too large for an automatic update (limit ${MAX_README_CHARS} characters).` }
    }
    if (readme.content.length > MAX_README_CHARS) {
      return { status: 'skipped', file: readme.name, warning: `The README is longer than ${MAX_README_CHARS} characters, so the automatic update was skipped.` }
    }
    const context = entry.turnContext || {}
    const files = Array.isArray(context.files) ? context.files : (Array.isArray(entry.files) ? entry.files : [])
    let profile = null
    try {
      profile = await collectProjectProfile(entry.cwd)
    } catch {
      profile = null
    }
    const readmeFormat = /\.rst$/i.test(readme.name) ? 'reStructuredText' : 'Markdown'
    const language = readme.existed
      ? (isCjkText(readme.content) ? 'Chinese (简体中文)' : 'English')
      : context.language === 'zh'
        ? 'Chinese (简体中文)'
        : context.language === 'en'
          ? 'English'
          : (isCjkText([context.userRequest || '', message].join('\n')) ? 'Chinese (简体中文)' : 'English')
    const system = [
      'You maintain the README of a software project.',
      `Update the ${readmeFormat} README after a completed coding turn.`,
      readme.existed
        ? 'Preserve the existing language, structure, badges, links, commands, and tone. Add or revise only the parts the change requires; do not remove correct existing information.'
        : 'The project has no README yet. Write a concise, accurate README from the project metadata and this change.',
      'Never invent features, commands, dependencies, files, or links that are not supported by the provided material.',
      'Return ONLY the complete README document. Do not wrap it in a code fence and do not add commentary.',
      'If the change does not require a README edit, return exactly NO_CHANGE.',
      `Write in ${language}.`,
    ].join('\n')
    const profileText = profile === null ? '' : [
      profile.metadata.join('\n'),
      profile.topLevel.length > 0 ? `Top-level entries: ${profile.topLevel.join(', ')}` : '',
    ].filter(Boolean).join('\n')
    const diffText = [
      context.stat ? `Diff stat:\n${context.stat}` : '',
      context.diff ? `Diff excerpt:\n${truncate(context.diff, 12000)}` : '',
      Array.isArray(context.untrackedSamples) && context.untrackedSamples.length > 0
        ? `New file excerpts:\n${context.untrackedSamples.map((item) => `--- ${item.file} ---\n${item.sample}`).join('\n\n')}`
        : '',
    ].filter(Boolean).join('\n\n')
    const prompt = [
      context.manual
        ? 'This README update belongs to a manual retry commit requested from Git settings.'
        : `This README update belongs to one completed coding turn (#${context.turn ?? entry.turn ?? '?'}).`,
      context.userRequest ? `User request:\n${truncate(context.userRequest, 2000)}` : '',
      context.assistantSummary ? `Agent's summary of the turn:\n${truncate(context.assistantSummary, 2000)}` : '',
      `Commit message:\n${message}`,
      files.length > 0 ? `Changed files:\n${files.slice(0, 100).map((file) => `- ${file}`).join('\n')}` : '',
      diffText,
      readme.existed
        ? `Current README (${readme.name}):\n${readme.content}`
        : 'Current README: none',
      profileText ? `Project metadata:\n${truncate(profileText, 5000)}` : '',
      'Return the complete updated README now, or exactly NO_CHANGE.',
    ].filter(Boolean).join('\n\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), README_LLM_TIMEOUT_MS)
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider: entry.ai.provider,
        model: entry.ai.model,
        temperature: 0.2,
        maxTokens: 4500,
        signal: controller.signal,
        purpose: 'git-auto-commit-readme',
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(chunk.reason?.failure?.message || 'The model did not finish the README update')
        }
      }
      let updated = stripMarkdownFence(text)
      if (updated === '') throw new Error('The model returned an empty README')
      const sentinel = updated.replace(/^["'“”]+|["'“”]+$/g, '').trim()
      if (/^(?:NO_CHANGE|NO CHANGE)\b/i.test(sentinel)) return { status: 'unchanged', file: readme.name }
      if (/^(?:diff --git |@@ )/m.test(updated)) throw new Error('The model returned a patch instead of a complete README')
      if (!updated.endsWith('\n')) updated += '\n'
      if (updated.length > MAX_README_OUTPUT_CHARS) {
        throw new Error(`The generated README is larger than ${MAX_README_OUTPUT_CHARS} characters`)
      }
      const oldTrim = readme.content.trim()
      if (oldTrim !== '' && updated.trim() === oldTrim) return { status: 'unchanged', file: readme.name }
      if (oldTrim.length >= 400 && updated.trim().length < oldTrim.length * 0.4) {
        throw new Error('The model returned a much shorter README, so the original was kept')
      }
      await writeAtomic(readme.file, updated)
      return { status: 'updated', file: readme.name }
    } catch (error) {
      console.warn(`[${PLUGIN}] README update failed:`, error?.message || error)
      return { status: 'failed', file: readme.name, warning: error?.message || String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ---------------------------------------------------------------- */
  /* commit and push                                                  */
  /* ---------------------------------------------------------------- */

  async function reconcileRemote(cwd, remoteUrl, branch, token, authorArgs) {
    const env = pushEnvironment(remoteUrl, token)
    await runGit(['fetch', remoteUrl, branch], cwd, env)
    try {
      await runGit([
        ...authorArgs,
        'merge',
        '--no-edit',
        '--allow-unrelated-histories',
        '-m', `merge: reconcile remote ${branch} before push`,
        'FETCH_HEAD',
      ], cwd)
    } catch (error) {
      try { await runGit(['merge', '--abort'], cwd) } catch { /* best effort */ }
      throw error
    }
    return (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim()
  }

  async function commitAndPush(entry, message) {
    const cwd = entry.cwd
    const config = {
      repository: entry.repository,
      branch: entry.branch,
    }
    const split = splitCommitMessage(message)
    if (split.subject === '') throw new Error('The commit message has no subject')
    await ensureRepoRoot(cwd, config.branch)
    let preparedRemoteUrl = ''
    let preparedToken
    if (entry.branchBase) {
      preparedRemoteUrl = await prepareRemote(cwd, config.repository)
      preparedToken = await readToken()
      await ensureNewBranch(cwd, preparedRemoteUrl, entry.branch, entry.branchBase, preparedToken)
    }
    const readme = entry.updateReadme === true ? await generateReadmeUpdate(entry, message) : null
    const readmeResult = readmeFields(readme)
    await runGit(['add', '-A', '--', '.'], cwd)
    const status = await runGit(['status', '--porcelain=v1', '-uall', '--', '.'], cwd)
    if (status.stdout.trim() === '') {
      return { status: 'no-changes', sessionId: entry.sessionId, repository: config.repository, branch: config.branch, manual: entry.manual === true, ...readmeResult }
    }
    const authorArgs = commitAuthorArgs()
    const commitArgs = [
      ...authorArgs,
      'commit',
      '-m', split.subject,
      ...(split.body === '' ? [] : ['-m', split.body]),
    ]
    let commitOutput
    try {
      commitOutput = await runGit(commitArgs, cwd)
    } catch (error) {
      return {
        status: 'commit-failed',
        sessionId: entry.sessionId,
        repository: config.repository,
        branch: config.branch,
        error: error?.message || String(error),
        manual: entry.manual === true,
        ...readmeResult,
      }
    }
    const hash = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim()
    const result = {
      status: 'committed',
      sessionId: entry.sessionId,
      repository: config.repository,
      branch: config.branch,
      commit: hash,
      subject: split.subject,
      files: entry.fileCount,
      manual: entry.manual === true,
      ...readmeResult,
    }
    let rejected = false
    try {
      const remoteUrl = preparedRemoteUrl === '' ? await prepareRemote(cwd, config.repository) : preparedRemoteUrl
      const token = preparedToken === undefined ? await readToken() : preparedToken
      const auth = pushEnvironment(remoteUrl, token)
      try {
        await runGit(['push', remoteUrl, `HEAD:${config.branch}`], cwd, auth)
      } catch (pushError) {
        if (!isNonFastForwardPush(pushError)) throw pushError
        rejected = true
        const mergeCommit = await reconcileRemote(cwd, remoteUrl, config.branch, token, authorArgs)
        await runGit(['push', remoteUrl, `HEAD:${config.branch}`], cwd, auth)
        result.status = 'pushed'
        result.pushed = true
        result.mergedRemote = true
        result.mergeCommit = mergeCommit
        return result
      }
      result.status = 'pushed'
      result.pushed = true
      return result
    } catch (pushError) {
      const rejectedNow = rejected || isNonFastForwardPush(pushError)
      return {
        ...result,
        status: 'push-failed',
        pushed: false,
        error: pushError?.message || String(pushError),
        recovery: rejectedNow
          ? `The commit ${hash.slice(0, 12)} is local. The remote history diverged and the automatic merge could not complete. Resolve it manually (git pull --allow-unrelated-histories), then push.`
          : `The commit ${hash.slice(0, 12)} is local. Fix the remote/token and run: git push <remote> HEAD:${config.branch}`,
      }
    }
  }

  function commitAuthorArgs() {
    const args = []
    if (state.global.userName.trim() !== '') args.push('-c', `user.name=${state.global.userName.trim()}`)
    if (state.global.userEmail.trim() !== '') args.push('-c', `user.email=${state.global.userEmail.trim()}`)
    return args
  }

  async function projectForSession(sessionId) {
    let header
    try {
      header = await sessionHeader(sessionId)
    } catch {
      header = undefined
    }
    if (header === undefined) return null
    let cwd = header.cwd
    const live = service('sessions')?.get(sessionId)
    if (live !== undefined) {
      try {
        const value = service('workingDirectory')?.get(live)
        if (typeof value === 'string' && value !== '') cwd = value
      } catch {
        // Fall back to the header cwd.
      }
    }
    if (typeof cwd !== 'string' || cwd === '') return null
    const config = await resolveSessionConfig(sessionId)
    return {
      sessionId,
      cwd,
      repository: config.repository,
      branch: config.branch,
      branchBase: config.branchBase || '',
      config,
      session: live ?? null,
    }
  }

  async function projectForWorkspace(workspaceId) {
    const registry = service('workspaceRegistry')
    if (registry === undefined) return null
    let workspace
    try {
      workspace = registry.get(workspaceId)
    } catch {
      workspace = undefined
    }
    if (workspace === undefined || typeof workspace.path !== 'string' || workspace.path === '') return null
    const config = state.workspaces[workspaceId]
    return {
      cwd: workspace.path,
      repository: config === undefined ? '' : expandRepository(config.repository || '', state.global.githubPrefix),
      branch: resolveBranch(config),
      branchBase: config?.branchBase || '',
      config,
      workspace,
    }
  }

  async function projectFromBody(body) {
    if (typeof body.sessionId === 'string' && body.sessionId !== '') return projectForSession(body.sessionId)
    if (typeof body.workspaceId === 'string' && body.workspaceId !== '') return projectForWorkspace(body.workspaceId)
    return null
  }

  async function currentBranchOf(cwd) {
    try {
      const name = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim()
      return name === 'HEAD' ? '' : name
    } catch {
      return ''
    }
  }

  async function requireCleanWorktree(cwd) {
    const status = await runGit(['status', '--porcelain=v1', '-uall', '--', '.'], cwd)
    const files = parseStatusFiles(status.stdout)
    if (files.length === 0) return
    const error = new Error(`The working tree has uncommitted changes: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}. Commit or stash them first.`)
    error.files = files
    throw error
  }

  async function unmergedFiles(cwd) {
    try {
      const { stdout } = await runGit(['diff', '--name-only', '--diff-filter=U'], cwd)
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  async function repoAuthEnv(repository) {
    return pushEnvironment(repository, await readToken())
  }

  async function readRemoteSnapshot(repository, cwd) {
    if (repository === '') return { heads: new Map(), defaultBranch: '', warning: null }
    const env = await repoAuthEnv(repository)
    let dir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    try {
      await fs.access(dir)
    } catch {
      dir = process.cwd()
    }
    try {
      const { stdout } = await runGit(['ls-remote', '--symref', repository], dir, env, REMOTE_CHECK_TIMEOUT_MS)
      const heads = new Map()
      let defaultBranch = ''
      for (const raw of stdout.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        if (line.startsWith('ref: ')) {
          const match = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/)
          if (match !== null) defaultBranch = match[1]
          continue
        }
        const parts = line.split(/\s+/)
        const hash = parts[0]
        const ref = parts[1]
        if (hash !== undefined && ref !== undefined && ref.startsWith('refs/heads/')) {
          heads.set(ref.slice('refs/heads/'.length), hash)
        }
      }
      return { heads, defaultBranch, warning: null }
    } catch (error) {
      return { heads: null, defaultBranch: '', warning: `Could not read remote branches: ${error?.message || String(error)}` }
    }
  }

  async function localRemoteHeads(cwd) {
    const heads = new Map()
    if (typeof cwd !== 'string' || cwd === '') return heads
    let repo = false
    try {
      repo = await isRepoRoot(cwd)
    } catch {
      repo = false
    }
    if (!repo) return heads
    try {
      const { stdout } = await runGit([
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        `refs/remotes/${REMOTE_NAME}`,
      ], cwd)
      const prefix = `${REMOTE_NAME}/`
      for (const raw of stdout.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const split = line.indexOf(' ')
        if (split < 0) continue
        const ref = line.slice(0, split)
        const hash = line.slice(split + 1).trim()
        if (!ref.startsWith(prefix)) continue
        const name = ref.slice(prefix.length)
        if (name === '' || name === 'HEAD') continue
        heads.set(name, hash)
      }
    } catch {
      // Local tracking refs are optional.
    }
    return heads
  }

  function remoteHeadsDiffer(remote, local) {
    if (remote.size !== local.size) return true
    for (const [name, hash] of remote) {
      if (local.get(name) !== hash) return true
    }
    return false
  }

  async function fetchRemoteTracking(cwd, repository) {
    const remoteUrl = await prepareRemote(cwd, repository)
    const token = await readToken()
    const env = pushEnvironment(remoteUrl, token)
    await runGit(['fetch', remoteUrl, `+refs/heads/*:refs/remotes/${REMOTE_NAME}/*`, '--prune'], cwd, env)
    return remoteUrl
  }

  async function readRemoteBranches(repository, cwd) {
    if (repository === '') {
      return { names: [], heads: new Map(), defaultBranch: '', warning: null, updated: false, remoteChecked: false }
    }
    let repo = false
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        repo = await isRepoRoot(cwd)
      } catch {
        repo = false
      }
    }
    const snapshot = await readRemoteSnapshot(repository, cwd)
    if (!repo) {
      return {
        names: snapshot.heads === null ? [] : [...snapshot.heads.keys()].sort(),
        heads: snapshot.heads,
        defaultBranch: snapshot.defaultBranch,
        warning: snapshot.warning,
        updated: false,
        remoteChecked: snapshot.heads !== null,
      }
    }
    let updated = false
    let syncWarning = null
    if (snapshot.heads !== null) {
      const local = await localRemoteHeads(cwd)
      if (remoteHeadsDiffer(snapshot.heads, local)) {
        try {
          await fetchRemoteTracking(cwd, repository)
          updated = true
        } catch (error) {
          syncWarning = `Could not update local remote refs: ${error?.message || String(error)}`
        }
      }
    }
    const local = await localRemoteHeads(cwd)
    const names = new Set(local.keys())
    if (snapshot.heads !== null) {
      for (const name of snapshot.heads.keys()) names.add(name)
    }
    return {
      names: [...names].sort(),
      heads: snapshot.heads,
      defaultBranch: snapshot.defaultBranch || state.global.defaultBranch || '',
      warning: snapshot.warning || syncWarning,
      updated,
      remoteChecked: snapshot.heads !== null,
    }
  }

  async function branchCatalogFor(cwd, repository, remoteInfo) {
    const local = new Set()
    let current = ''
    let localWarning = null
    let repo = false
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        repo = await isRepoRoot(cwd)
        if (repo) {
          const names = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd)
          for (const line of names.stdout.split('\n')) {
            const name = line.trim()
            if (name !== '') local.add(name)
          }
          current = await currentBranchOf(cwd)
        }
      } catch (error) {
        localWarning = `Could not read local branches: ${error?.message || String(error)}`
      }
    }
    const remote = remoteInfo || await readRemoteBranches(repository, cwd)
    const map = new Map()
    for (const name of local) map.set(name, { name, local: true, remote: false, current: name === current })
    for (const name of remote.names) {
      const entry = map.get(name)
      if (entry !== undefined) entry.remote = true
      else map.set(name, { name, local: false, remote: true, current: name === current })
    }
    if (current !== '' && !map.has(current)) map.set(current, { name: current, local: true, remote: false, current: true })
    const defaultBranch = remote.defaultBranch || state.global.defaultBranch || ''
    const branches = [...map.values()].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      const aDefault = a.name === defaultBranch
      const bDefault = b.name === defaultBranch
      if (aDefault !== bDefault) return aDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return {
      branches,
      current,
      defaultBranch,
      warning: remote.warning || localWarning,
      updated: remote.updated === true,
      remoteChecked: remote.remoteChecked === true,
      repo,
    }
  }

  async function resolveBranchCommit(cwd, repository, branch, remoteUrlOverride) {
    const name = String(branch || '').trim()
    if (name === '') throw new Error('The base branch is required')
    try {
      const local = (await runGit(['rev-parse', '--verify', `refs/heads/${name}^{commit}`], cwd)).stdout.trim()
      if (local !== '') return local
    } catch {
      // Fall through to the remote.
    }
    const remoteUrl = remoteUrlOverride || await prepareRemote(cwd, repository)
    if (!remoteUrl) throw new Error(`Cannot resolve branch ${name}`)
    const token = await readToken()
    const env = pushEnvironment(remoteUrl, token)
    await runGit(['fetch', remoteUrl, name], cwd, env)
    return (await runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], cwd)).stdout.trim()
  }

  async function pushRef(cwd, repository, refspec) {
    const remoteUrl = await prepareRemote(cwd, repository)
    const token = await readToken()
    const env = pushEnvironment(remoteUrl, token)
    await runGit(['push', remoteUrl, refspec], cwd, env)
    return remoteUrl
  }

  async function attachPushResult(result, project, branch, shouldPush) {
    if (shouldPush !== true) return
    if (project.repository === '') {
      result.pushSkipped = 'No repository is configured.'
      return
    }
    try {
      await pushRef(project.cwd, project.repository, `HEAD:${branch}`)
      result.pushed = true
    } catch (error) {
      result.pushed = false
      result.pushError = error?.message || String(error)
      if (isNonFastForwardPush(error)) {
        result.pushError += ' A force push is required for the rewritten history and was not performed automatically.'
      }
    }
  }

  async function ensureNewBranch(cwd, remoteUrl, branch, base, token) {
    let exists = false
    try {
      await runGit(['show-ref', '--verify', `refs/heads/${branch}`], cwd)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      try {
        await runGit(['checkout', branch], cwd)
      } catch (error) {
        throw new Error(`Could not check out ${branch}: ${error?.message || String(error)}`)
      }
      return { status: 'existing' }
    }
    if (remoteUrl !== '') {
      let remoteNames = []
      try {
        const { stdout } = await runGit(['ls-remote', '--heads', remoteUrl, branch], cwd, pushEnvironment(remoteUrl, token))
        remoteNames = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      } catch {
        remoteNames = []
      }
      if (remoteNames.length > 0) {
        throw new Error(`A remote branch named ${branch} already exists. Select it from the branch list instead.`)
      }
    }
    const baseCommit = base === '' ? '' : await resolveBranchCommit(cwd, '', base, remoteUrl)
    try {
      await runGit(baseCommit === '' ? ['checkout', '-b', branch] : ['checkout', '-b', branch, baseCommit], cwd)
    } catch (error) {
      throw new Error(`Could not create branch ${branch}${base === '' ? '' : ` from ${base}`}: ${error?.message || String(error)}`)
    }
    return { status: 'created', base: baseCommit }
  }

  async function prepareRemote(cwd, repository) {
    if (looksLikeRemote(repository)) {
      let current = ''
      try {
        current = (await runGit(['remote', 'get-url', REMOTE_NAME], cwd)).stdout.trim()
      } catch {
        current = ''
      }
      if (current === '') {
        await runGit(['remote', 'add', REMOTE_NAME, repository], cwd)
      } else if (current !== repository) {
        await runGit(['remote', 'set-url', REMOTE_NAME, repository], cwd)
      }
      return repository
    }
    let local = expandHome(repository)
    if (!path.isAbsolute(local)) local = path.resolve(cwd, local)
    let kind = 'none'
    try {
      const bare = (await runGit(['rev-parse', '--is-bare-repository'], local)).stdout.trim()
      if (bare === 'true') kind = 'bare'
    } catch {
      kind = 'none'
    }
    if (kind === 'none') {
      try {
        const top = (await runGit(['rev-parse', '--show-toplevel'], local)).stdout.trim()
        if (path.resolve(top) === path.resolve(local)) kind = 'worktree'
      } catch {
        kind = 'none'
      }
    }
    if (kind === 'none') {
      await fs.mkdir(path.dirname(local), { recursive: true })
      await runGit(['init', '--bare', local], cwd)
    }
    return local
  }
}

/* ------------------------------------------------------------------ */
/* test surface                                                       */
/* ------------------------------------------------------------------ */

export const __internals = {
  DEFAULT_STATE,
  normalizeState,
  normalizeCommitMessage,
  splitCommitMessage,
  parseStatusFiles,
  parseToolArguments,
  pathArguments,
  firstLine,
  isCjkText,
  validBranch,
  looksLikeRemote,
  pushEnvironment,
  expandHome,
  normalizeGithubPrefix,
  githubOrigin,
  autoGithubPrefix,
  expandRepository,
  parseGitHubRepository,
  githubPrefixHasAccount,
  collectProjectProfile,
  readProjectReadme,
  stripMarkdownFence,
  cleanAiDescription,
  isShortRepositoryName,
  inspectChanges,
}
