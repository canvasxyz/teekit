#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as chalk from "colorette"

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  return result.status === 0
}

function which(binary) {
  const res = spawnSync('bash', ['-lc', `command -v ${binary}`], { stdio: 'pipe' })
  return res.status === 0 && String(res.stdout || '').trim().length > 0
}

function joinLines(strings) {
  return strings.join('\n')
}

function ensureBrewOnLinux() {
  // If brew already exists, nothing to do
  if (which('brew')) return true

  // Install Homebrew non-interactively (Linuxbrew)
  const installCmd = joinLines([
    'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  ])

  const ok = run('bash', ['-lc', installCmd], { env: { ...process.env, NONINTERACTIVE: '1' } })
  if (!ok) return false

  // Configure shell env for current process
  const brewPrefix = '/home/linuxbrew/.linuxbrew'
  const brewBin = `${brewPrefix}/bin/brew`
  const envCmd = `${brewBin} shellenv`
  const evalRes = spawnSync('bash', ['-lc', `eval "$(${envCmd})"; echo "$HOMEBREW_PREFIX"`], { encoding: 'utf8' })
  if (evalRes.status !== 0) return false

  // Update env of this process for subsequent calls
  const pref = evalRes.stdout.trim() || brewPrefix
  process.env.HOMEBREW_PREFIX = pref
  process.env.PATH = `${pref}/bin:${process.env.PATH}`
  return true
}

function ensureBrewOnMac() {
  if (which('brew')) return true
  const ok = run('bash', ['-lc', 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'], { env: { ...process.env, NONINTERACTIVE: '1' } })
  if (!ok) return false
  // Add brew to PATH for current process (Apple Silicon default path)
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of candidates) {
    if (existsSync(dir)) {
      process.env.PATH = `${dir}:${process.env.PATH}`
    }
  }
  return true
}

function ensureSqld() {
  // Respect SQLD_BIN if provided
  if (process.env.SQLD_BIN && existsSync(process.env.SQLD_BIN)) return true

  // Check common locations
  const candidates = [
    'sqld',
    '/home/linuxbrew/.linuxbrew/bin/sqld',
    '/opt/homebrew/bin/sqld',
    '/usr/local/bin/sqld',
    '/usr/bin/sqld',
  ]
  for (const bin of candidates) {
    if (bin === 'sqld') {
      if (which('sqld')) return true
    } else if (existsSync(bin)) {
      return true
    }
  }

  // Not found: attempt to install via brew
  const platform = process.platform
  if (platform === 'linux') {
    if (!ensureBrewOnLinux()) return false
  } else if (platform === 'darwin') {
    if (!ensureBrewOnMac()) return false
  } else {
    // Unsupported OS for automatic install; silently skip to avoid breaking install
    console.warn('[postinstall] sqld auto-install is only supported on macOS/Linux')
    return true
  }

  // Use brew to tap and install
  const okTap = run('bash', ['-lc', 'brew tap libsql/sqld'])
  const okInstall = okTap && run('bash', ['-lc', 'brew install sqld'])

  if (!okInstall) {
    console.warn('[postinstall] Failed to install sqld via Homebrew. Please install manually.')
    return false
  }

  return which('sqld') || existsSync('/home/linuxbrew/.linuxbrew/bin/sqld') || existsSync('/opt/homebrew/bin/sqld')
}

function main() {
  // CI has its own setup for sqld; do not auto-install
  const ci = String(process.env.CI || '').toLowerCase()
  if (ci === 'true' || ci === '1') {
    return
  }

  const ensured = ensureSqld()
  if (!ensured) {
    console.warn(chalk.yellowBright('[postinstall] sqld not found, could not be installed automatically'))
  } else {
    console.info(chalk.yellowBright('[postinstall] sqld available'))
  }
}

main()
