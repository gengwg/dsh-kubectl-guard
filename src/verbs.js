// Verb tiers. Data, not code: adding a binary or verb is an edit here.

// Irreversible: no undo, no dry-run that helps. Hard denied outside local contexts.
export const IRREVERSIBLE = new Set(['delete', 'drain'])

// Mutating but recoverable. Asked, with a diff where one is available.
export const REVERSIBLE = new Set([
  'apply', 'patch', 'scale', 'replace', 'edit', 'create', 'annotate', 'label',
  'set', 'rollout', 'cordon', 'uncordon', 'taint', 'expose', 'autoscale',
  'exec', 'cp',
])

// `config` subcommands that only read the kubeconfig.
const CONFIG_READS = new Set(['current-context', 'get-contexts', 'get-clusters', 'get-users', 'view'])

// Everything else is treated as a read.
export const READ = new Set([
  'get', 'describe', 'logs', 'top', 'events', 'explain', 'version', 'diff',
  'api-resources', 'api-versions', 'cluster-info', 'auth', 'config',
  'wait', 'port-forward',
])

// Output formats that print no field values. Anything else, including a
// format we don't recognize, can print a secret's data.
const VALUELESS_OUTPUT = new Set(['name', 'wide', 'yaml'])

const isSecretResource = (arg) => arg.split(',').some((r) => {
  const kind = r.toLowerCase().split('/')[0].split('.')[0]
  return kind === 'secret' || kind === 'secrets'
})

/**
 * A read whose output carries credentials: secret values, or the kubeconfig's
 * keys and tokens. Plain `get secret` and `describe secret` print names and
 * sizes only, so they stay reads.
 */
export function revealsSecrets(inv) {
  if (inv.verb === 'config') return inv.sub === 'view' && inv.raw !== undefined
  if (inv.verb !== 'get') return false
  if (inv.raw !== undefined && /\/secrets(\/|\?|$)/.test(inv.raw)) return true
  const printsValues = inv.template || (inv.output !== undefined && !VALUELESS_OUTPUT.has(inv.output))
  return printsValues && inv.args.some(isSecretResource)
}

/**
 * Tier a parsed invocation. `scale --replicas=0` is promoted to irreversible:
 * it discards running state as thoroughly as a delete.
 */
export function tierOf(inv) {
  if (IRREVERSIBLE.has(inv.verb)) return 'irreversible'
  if (inv.verb === 'scale' && inv.replicas === 0) return 'irreversible'
  // `apply --prune` deletes resources absent from the manifest set, and
  // `replace --force` is a delete followed by a create.
  if (inv.verb === 'apply' && inv.prune) return 'irreversible'
  if (inv.verb === 'replace' && inv.force) return 'irreversible'
  // `auth can-i` reads, but `auth reconcile` writes RBAC objects.
  if (inv.verb === 'auth' && inv.sub === 'reconcile') return 'reversible'
  // Mutating config subcommands write the kubeconfig, so they ask even when
  // the ambient context is local. `use-context` is the dangerous one: it
  // retargets every later command in the session, and a `use-context prod &&
  // delete` chain in one line would otherwise resolve the delete against the
  // pre-switch context. Reads keep the read tier; an unrecognized subcommand
  // is not evidence that it is safe.
  if (inv.verb === 'config') {
    if (CONFIG_READS.has(inv.sub)) return 'read'
    return inv.sub === undefined ? 'unknown' : 'reversible'
  }
  if (REVERSIBLE.has(inv.verb)) return 'reversible'
  if (READ.has(inv.verb)) return 'read'
  return 'unknown'
}
