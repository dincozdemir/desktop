import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import log from 'electron-log'
import * as pty from 'node-pty'

import {
  getConfig,
  getPythonPath,
  getUserDataPath,
  installPackage,
  isPackageInstalled,
  isPythonInstalled,
  portInUse,
  setConfig,
  type AppConfig
} from './index'

const execFileAsync = promisify(execFile)
const DEFAULT_PORT = 8000
const GITHUB_MCP_VERSION = '1.0.5'
const DEFAULT_GITHUB_MCP_TOOLSETS = 'all'
// Install our fork because the headless bootstrap command is part of this
// product integration, not the upstream PyPI release yet.
const COMPUTER_PACKAGE =
  process.env.WU_COMPUTER_PACKAGE || 'cptr[all] @ git+https://github.com/dincozdemir/computer.git'

let computerProcess: pty.IPty | null = null
type ComputerInfo = {
  url: string
  pid: number
  status: 'starting' | 'started' | 'stopped'
  logs: string[]
}

let info: ComputerInfo | null = null

const computerDataPath = (): string => path.join(getUserDataPath(), 'computer')

const githubMcpBinaryPath = (): string =>
  path.join(computerDataPath(), 'bin', 'github-mcp-server')

const ensureGithubMcpServer = async (
  onStatus?: (message: string) => void
): Promise<string> => {
  if (process.platform !== 'darwin') return ''

  const binaryPath = githubMcpBinaryPath()
  if (fs.existsSync(binaryPath)) return binaryPath

  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const assetName = `github-mcp-server_Darwin_${arch}.tar.gz`
  const assetUrl =
    `https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/${assetName}`
  const binDir = path.dirname(binaryPath)
  const archivePath = path.join(binDir, assetName)

  try {
    onStatus?.('Installing GitHub tools…')
    fs.mkdirSync(binDir, { recursive: true })
    const response = await fetch(assetUrl)
    if (!response.ok) throw new Error(`GitHub MCP download failed (HTTP ${response.status})`)
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))
    await execFileAsync('tar', ['-xzf', archivePath, '-C', binDir])
    fs.rmSync(archivePath, { force: true })
    if (!fs.existsSync(binaryPath)) throw new Error('GitHub MCP archive did not contain its binary')
    fs.chmodSync(binaryPath, 0o755)
    return binaryPath
  } catch (error) {
    fs.rmSync(archivePath, { force: true })
    log.warn('GitHub MCP tools are unavailable:', error)
    onStatus?.('GitHub tools could not be installed; continuing without them.')
    return ''
  }
}

const beginGithubLoginIfNeeded = async (
  onStatus?: (message: string) => void
): Promise<void> => {
  try {
    await execFileAsync('gh', ['auth', 'status', '--active', '--hostname', 'github.com'], {
      env: processEnv()
    })
    return
  } catch {
    // GitHub CLI owns this browser flow and stores the resulting credential
    // in the user's Keychain. It is intentionally detached from app startup.
    onStatus?.('Sign in to GitHub in your browser to enable GitHub tools…')
    const login = execFile(
      'gh',
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--web',
        '--git-protocol',
        'https',
        '--skip-ssh-key'
      ],
      { env: processEnv() },
      () => {}
    )
    login.unref()
  }
}

const generateSecret = (prefix = ''): string =>
  `${prefix}${crypto.randomBytes(32).toString('base64url')}`

const ensureComputerConfig = async (config: AppConfig): Promise<AppConfig> => {
  const current = config.computer ?? {
    enabled: false,
    port: DEFAULT_PORT,
    workspace: os.homedir(),
    gatewayKey: '',
    upstreamUrl: '',
    upstreamApiKey: '',
    upstreamModel: ''
  }
  const computer = {
    ...current,
    port: current.port || DEFAULT_PORT,
    workspace: current.workspace || os.homedir(),
    gatewayKey: current.gatewayKey || generateSecret('sk-cptr-')
  }
  if (JSON.stringify(computer) !== JSON.stringify(config.computer)) {
    await setConfig({ computer })
    return await getConfig()
  }
  return config
}

const provision = async (
  config: AppConfig,
  onStatus?: (message: string) => void
): Promise<AppConfig> => {
  const updated = await ensureComputerConfig(config)
  const computer = updated.computer
  const pythonPath = getPythonPath()
  const password = generateSecret()
  const githubMcpPath = await ensureGithubMcpServer(onStatus)
  if (githubMcpPath) await beginGithubLoginIfNeeded(onStatus)
  const githubMcpToolsets =
    process.env.WU_GITHUB_MCP_TOOLSETS || DEFAULT_GITHUB_MCP_TOOLSETS
  const environment = {
    ...processEnv(),
    CPTR_DATA_DIR: computerDataPath(),
    CPTR_BOOTSTRAP_PASSWORD: password,
    CPTR_GATEWAY_KEY: computer.gatewayKey,
    ...(githubMcpPath ? { CPTR_GITHUB_MCP_PATH: githubMcpPath } : {}),
    ...(githubMcpPath ? { CPTR_GITHUB_MCP_TOOLSETS: githubMcpToolsets } : {}),
    ...(computer.upstreamApiKey ? { CPTR_UPSTREAM_API_KEY: computer.upstreamApiKey } : {})
  }
  const args = [
    '-m',
    'uv',
    'run',
    'cptr',
    'bootstrap',
    '--username',
    'wu-desktop',
    '--workspace',
    computer.workspace,
    ...(computer.upstreamUrl ? ['--upstream-url', computer.upstreamUrl] : []),
    ...(computer.upstreamModel ? ['--upstream-model', computer.upstreamModel] : [])
  ]
  const { stdout } = await execFileAsync(pythonPath, args, { env: environment })
  // Migration tooling may emit diagnostics before the machine-readable result.
  const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  const result = jsonLine ? JSON.parse(jsonLine) : null
  if (!result?.ok) throw new Error('Computer bootstrap did not complete')
  // Persist the discovered ID locally (it is not a secret). Future launches
  // can provision idempotently without querying the upstream again after its
  // API key has been handed off to Computer's encrypted configuration.
  const discoveredModel = typeof result.upstream_model === 'string' ? result.upstream_model : ''
  if (discoveredModel) {
    const message = `Selected main-server model: ${discoveredModel}`
    log.info(message)
    onStatus?.(message)
  }
  const computerWithModel =
    discoveredModel && discoveredModel !== computer.upstreamModel
      ? { ...computer, upstreamModel: discoveredModel }
      : computer
  // Computer persists this credential encrypted in its own configuration;
  // do not retain it in Desktop's JSON after first provisioning.
  if (computer.upstreamApiKey) {
    await setConfig({ computer: { ...computerWithModel, upstreamApiKey: '' } })
    return await getConfig()
  }
  if (computerWithModel !== computer) {
    await setConfig({ computer: computerWithModel })
    return await getConfig()
  }
  return updated
}

const processEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONUNBUFFERED: '1',
  ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
})

export const getComputerInfo = (): ComputerInfo | null =>
  info && {
    url: info.url,
    pid: info.pid,
    status: info.status,
    logs: info.logs
  }

export const startComputer = async (
  onStatus?: (message: string) => void
): Promise<ComputerInfo | null> => {
  if (info?.status === 'started') return getComputerInfo()
  if (!isPythonInstalled()) throw new Error('Python is not installed')
  // The integrated launcher asks for a refresh only after it rebuilt its
  // local wheel. This avoids reinstalls on ordinary restarts while preventing
  // Desktop and Computer from running incompatible revisions.
  if (!isPackageInstalled('cptr') || process.env.WU_COMPUTER_FORCE_INSTALL === '1') {
    onStatus?.('Installing Open WebUI Computer…')
    await installPackage(COMPUTER_PACKAGE)
  }

  let config = await provision(await getConfig(), onStatus)
  let computer = config.computer
  const host = '127.0.0.1'
  let port = computer.port || DEFAULT_PORT
  while (await portInUse(port, host)) {
    port += 1
    if (port > (computer.port || DEFAULT_PORT) + 100)
      throw new Error('No available port for Open WebUI Computer')
  }
  if (port !== computer.port) {
    await setConfig({ computer: { ...computer, port } })
    config = await getConfig()
    computer = config.computer
  }

  fs.mkdirSync(computerDataPath(), { recursive: true })
  const pythonPath = getPythonPath()
  const args = [
    '-m',
    'uv',
    'run',
    'cptr',
    'run',
    '--host',
    host,
    '--port',
    String(port),
    '--headless'
  ]
  const spawned = pty.spawn(pythonPath, args, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    env: { ...processEnv(), CPTR_DATA_DIR: computerDataPath() }
  })
  const url = `http://${host}:${port}`
  info = { url, pid: spawned.pid, status: 'starting', logs: [] }
  computerProcess = spawned
  spawned.onData((data) => {
    info?.logs.push(data)
    log.info(`[Computer:${spawned.pid}] ${data.replace(/[\r\n]+/g, ' ').trim()}`)
  })
  spawned.onExit(({ exitCode, signal }) => {
    log.info(`[Computer:${spawned.pid}] exited code=${exitCode} signal=${signal}`)
    if (info?.pid === spawned.pid) info.status = 'stopped'
    computerProcess = null
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) {
        info.status = 'started'
        return getComputerInfo()
      }
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await stopComputer()
  throw new Error('Open WebUI Computer did not become healthy within 30 seconds')
}

export const stopComputer = async (): Promise<void> => {
  if (!computerProcess) return
  try {
    computerProcess.kill()
  } catch (error) {
    log.warn('Failed to stop Open WebUI Computer:', error)
  }
  computerProcess = null
  if (info) info.status = 'stopped'
}
