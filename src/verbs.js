// Verb tiers. Data, not code: adding a binary or verb is an edit here.

// Irreversible: no undo, no dry-run that helps. Hard denied outside local contexts.
export const IRREVERSIBLE = new Set(['delete', 'drain', 'evict'])

// Mutating but recoverable. Asked, with a diff where one is available.
export const REVERSIBLE = new Set([
  'apply', 'patch', 'scale', 'replace', 'edit', 'create', 'annotate', 'label',
  'set', 'rollout', 'cordon', 'uncordon', 'taint', 'expose', 'autoscale',
  'exec', 'cp',
])

// Everything else is treated as a read.
export const READ = new Set([
  'get', 'describe', 'logs', 'top', 'events', 'explain', 'version', 'diff',
  'api-resources', 'api-versions', 'cluster-info', 'auth', 'config',
  'wait', 'port-forward',
])

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
  if (REVERSIBLE.has(inv.verb)) return 'reversible'
  if (READ.has(inv.verb)) return 'read'
  return 'unknown'
}
