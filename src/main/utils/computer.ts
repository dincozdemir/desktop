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

const provision = async (config: AppConfig): Promise<AppConfig> => {
  const updated = await ensureComputerConfig(config)
  const computer = updated.computer
  const pythonPath = getPythonPath()
  const password = generateSecret()
  const environment = {
    ...processEnv(),
    CPTR_DATA_DIR: computerDataPath(),
    CPTR_BOOTSTRAP_PASSWORD: password,
    CPTR_GATEWAY_KEY: computer.gatewayKey,
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

  let config = await provision(await getConfig())
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
