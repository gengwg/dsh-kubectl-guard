// Local-or-production classification. Deny by default: a context is production
// unless it matches an explicit local pattern.

export const DEFAULT_LOCAL = ['minikube', 'kind-*', 'docker-desktop', 'docker-for-desktop', 'rancher-desktop', 'k3d-*', 'colima']

/** Glob with `*` only; anchored. */
function matches(pattern, value) {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(value)
}

/**
 * @param {string|null} context null means unresolvable, which is production.
 * @param {string[]} localPatterns
 * @returns {'local'|'production'}
 */
export function classify(context, localPatterns = DEFAULT_LOCAL) {
  if (!context) return 'production'
  return localPatterns.some((p) => matches(p, context)) ? 'local' : 'production'
}
