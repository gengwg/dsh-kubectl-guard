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
  // Monotonic deny: irreversible writes outside a local cluster. Synchronous,
  // so everything it calls must be synchronous too.
  ctx.tools.guard((exec) => {
    const command = commandOf(exec, config.guardedTools)
    if (command === null) return undefined
    const verdict = decide(command, config)
    return verdict.action === 'deny' ? verdict.reason : undefined
  })

  // Ask for recoverable writes. Runs before guards, so a deny still wins.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const command = commandOf(exec, config.guardedTools)
    if (command === null) return next()
    const verdict = decide(command, config)
    if (verdict.action !== 'ask') return next()
    return { kind: 'ask', reason: verdict.reason }
  })
}

export { Config, apply, inject, name }
