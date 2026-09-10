/**
 * dsh-skill-recommender — child-process environment.
 *
 * Reading a DSH session log shells out to `zstd`, which lives in a package
 * manager's bin directory. DSH itself can be started by launchd (the shipped
 * `com.dsh.web` service), whose PATH is only `/usr/bin:/bin`, so a bare
 * `zstd` fails with ENOENT — and the per-file catch around it would silently
 * skip every DSH session. Resolve the binary and widen PATH explicitly.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Well-known directories that commonly hold a globally installed CLI. */
function extraBinDirs(): string[] {
  const home = homedir()
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
    '/bin',
  ]
  // Node version managers keep each release under its own bin directory.
  for (const manager of ['.nvm/versions/node', '.local/share/fnm/node-versions', '.asdf/installs/nodejs']) {
    const root = path.join(home, manager)
    try {
      for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, 'bin'))
    } catch {
      // Not installed with this manager — nothing to add.
    }
  }
  return dirs
}

/**
 * Resolve an executable name to an absolute path.
 * @param name - bare executable name.
 * @returns the first existing absolute path, or the bare name so the OS still
 *   performs its own PATH lookup and reports a meaningful error.
 */
export function resolveExecutable(name: string): string {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const seen = new Set<string>()
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...extraBinDirs()]) {
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return name
}

/**
 * The inherited environment with PATH widened by every existing well-known
 * bin directory, for spawns that must find a package-manager binary.
 * @returns a copy of `process.env` safe to hand to a child process.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const segments = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '')
  const seen = new Set(segments)
  for (const dir of extraBinDirs()) {
    if (seen.has(dir) || !existsSync(dir)) continue
    seen.add(dir)
    segments.push(dir)
  }
  return { ...process.env, PATH: segments.join(path.delimiter) }
}
