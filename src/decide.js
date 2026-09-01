// The whole policy, as one pure-ish function. Kept separate from the cordis
// wiring so it can be tested as a table of strings in, decisions out.

import { parseCommand } from './matcher.js'
import { resolveContext } from './resolver.js'
import { classify } from './classifier.js'
import { tierOf, IRREVERSIBLE } from './verbs.js'
import { label } from './redact.js'

const RANK = { allow: 0, ask: 1, deny: 2 }

/** A dry run mutates nothing, so it drops to a read. */
const isDryRun = (inv) => inv.dryRun !== undefined && inv.dryRun !== 'none'

export function decide(command, cfg, env = process.env) {
  const binaries = new Set(cfg.binaries)
  const { invocations, ambiguous } = parseCommand(command, binaries)

  let worst = { action: 'allow' }
  const take = (next) => { if (RANK[next.action] > RANK[worst.action]) worst = next }

  if (ambiguous) {
    const hitsIrreversible = [...IRREVERSIBLE].some((v) =>
      new RegExp(`(^|\\s)${v}(\\s|$)`).test(command))
    take(hitsIrreversible
      ? { action: 'deny', reason: 'kubectl-guard: command could not be parsed with confidence and contains an irreversible verb; refusing rather than guessing. Run it yourself if you intend it.' }
      : { action: 'ask', reason: 'kubectl-guard: command could not be parsed with confidence and may mutate a cluster.' })
  }

  for (const inv of invocations) {
    const { context } = resolveContext(inv, env)
    if (classify(context, cfg.localContexts) === 'local') continue

    const where = label(context, cfg.showContextNames)
    const tier = isDryRun(inv) ? 'read' : tierOf(inv)

    if (tier === 'read') continue
    if (tier === 'irreversible') {
      take({ action: 'deny', context, reason: `kubectl-guard: '${inv.verb}' is irreversible and ${where} is not a local cluster. Denied.` })
    } else {
      // 'reversible' and 'unknown' both ask: an unrecognized verb is not
      // evidence that it is safe.
      take({ action: 'ask', context, reason: `kubectl-guard: '${inv.verb}' writes to ${where}, which is not a local cluster.` })
    }
  }
  return worst
}
