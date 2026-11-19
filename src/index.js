import { appendFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { decide } from './decide.js'
import { DEFAULT_LOCAL } from './classifier.js'

const name = 'kubectl-guard'
const inject = ['tools']

const Config = z.object({
  localContexts: z.array(z.string()).default(DEFAULT_LOCAL)
    .description('Context names treated as safe. `*` globs. Everything else is production.'),
  binaries: z.array(z.string()).default(['kubectl', 'k'])
    .description('Command basenames to inspect.'),
  guardedTools: z.array(z.string()).default(['bash', 'pwsh'])
    .description('Tool names whose `command` argument is inspected.'),
  showContextNames: z.boolean().default(false)
    .description('Send real context names to the model instead of a per-session pseudonym.'),
  haltAfterDenials: z.natural().default(3)
    .description('After this many kubectl denials in a row, refuse every kubectl command for the rest of the session. 0 disables.'),
  decisionLog: z.string().default('')
    .description('Append one JSON line per kubectl decision (time, action, verbs, reason) to this file. Empty disables.'),
})

/** Pull the command string out of an untrusted tool-call argument bag. */
function commandOf(exec, guardedTools) {
  if (!guardedTools.includes(exec.name)) return null
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return null
  const command = args.command
  return typeof command === 'string' ? command : null
}

function apply(ctx, config) {
  // Consecutive kubectl denials per session. An agent that keeps trying variants
  // after being refused is routing around the guard, so after a few in a row
  // kubectl stops for that session. Calls without an agent session share one key.
  const denials = new WeakMap()
  const noSession = {}
  const sessionOf = (exec) => exec.agent?.session ?? noSession
  const isHalted = (session) => config.haltAfterDenials > 0 && (denials.get(session) ?? 0) >= config.haltAfterDenials
  const halt = `kubectl-guard: ${config.haltAfterDenials} kubectl commands in a row were denied, so kubectl is halted for this session. Stop and ask the user how to proceed.`

  let logBroken = false
  const record = (entry) => {
    if (!config.decisionLog || logBroken) return
    try {
      appendFileSync(config.decisionLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    } catch (error) {
      // A bad log path must not block commands; say so once instead of on every call.
      logBroken = true
      console.error(`kubectl-guard: cannot write decisionLog ${config.decisionLog}: ${error.message}`)
    }
  }

  // Monotonic deny: irreversible writes outside a local cluster, and everything
  // once a session is halted. Synchronous, so everything it calls must be too.
  ctx.tools.guard((exec) => {
    const command = commandOf(exec, config.guardedTools)
    if (command === null) return undefined
    const verdict = decide(command, config)
    if (!verdict.guarded) return undefined
    const session = sessionOf(exec)
    if (isHalted(session)) {
      record({ action: 'deny', verbs: verdict.verbs, reason: halt })
      return halt
    }
    if (verdict.action !== 'deny') {
      denials.delete(session)
      if (verdict.action === 'allow') record({ action: 'allow', verbs: verdict.verbs })
      return undefined
    }
    denials.set(session, (denials.get(session) ?? 0) + 1)
    const reason = isHalted(session) ? `${verdict.reason} ${halt}` : verdict.reason
    record({ action: 'deny', verbs: verdict.verbs, reason })
    return reason
  })

  // Ask for recoverable writes. Runs before guards, so a deny still wins. A halted
  // session gets no prompt: the guard refuses the call.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const command = commandOf(exec, config.guardedTools)
    if (command === null) return next()
    if (isHalted(sessionOf(exec))) return next()
    const verdict = decide(command, config)
    if (verdict.action !== 'ask') return next()
    record({ action: 'ask', verbs: verdict.verbs, reason: verdict.reason })
    return { kind: 'ask', reason: verdict.reason }
  })
}

export { Config, apply, inject, name }
