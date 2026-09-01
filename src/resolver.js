// Resolves the kubeconfig context a command will actually hit.
//
// Synchronous by necessity: ctx.tools.guard() is a synchronous seam, so the
// deny path cannot await. Reads are cached on (path, mtime, size).

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cache = new Map()

/** KUBECONFIG may list several files; the first one owns current-context. */
function primaryPath(explicit, env) {
  if (explicit) return explicit
  const fromEnv = env.KUBECONFIG
  if (fromEnv) {
    const first = fromEnv.split(':').filter(Boolean)[0]
    if (first) return first
  }
  return join(homedir(), '.kube', 'config')
}

/**
 * Read `current-context` from a kubeconfig.
 * @returns {string|null} null when it cannot be determined, which callers must
 *   treat as non-local rather than as absence of risk.
 */
function currentContext(path) {
  let key
  try {
    const st = statSync(path)
    key = `${path}:${st.mtimeMs}:${st.size}`
    if (cache.has(key)) return cache.get(key)
  } catch {
    return null
  }
  let value = null
  try {
    const text = readFileSync(path, 'utf8')
    const m = text.match(/^current-context:[ \t]*(?:"([^"]*)"|'([^']*)'|(\S+))[ \t]*$/m)
    const found = m?.[1] ?? m?.[2] ?? m?.[3]
    if (found) value = found
  } catch {
    value = null
  }
  cache.set(key, value)
  return value
}

/**
 * @param {object} inv parsed invocation
 * @param {NodeJS.ProcessEnv} env
 * @returns {{context: string|null, source: 'flag'|'kubeconfig'}}
 */
export function resolveContext(inv, env = process.env) {
  if (inv.context) return { context: inv.context, source: 'flag' }
  return {
    context: currentContext(primaryPath(inv.kubeconfig, env)),
    source: 'kubeconfig',
  }
}

export const _clearCache = () => cache.clear()
