// Parses a shell command string into kubectl invocations.
//
// Safety posture: this is a gate, so it must never under-report. Anything it
// cannot confidently read is reported as ambiguous, and the caller treats
// ambiguity as a mutation.

const OPAQUE = [/\$\{?[A-Za-z_]/, /\$\(/, /`/, /\beval\b/, /\bxargs\b/, /(^|\s)(ba)?sh\s+-c\b/]
const OPERATORS = new Set(['&&', '||', '|', ';', '\n', '&'])

/** Tokenize one command, honoring quotes so operators inside strings do not split it. */
function tokenize(text) {
  const tokens = []
  let current = ''
  let quote = null
  let pending = ''
  const push = () => { if (current !== '') { tokens.push(current); current = '' } }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { current += text[++i] ?? ''; continue }
      if (ch === quote) { quote = null; continue }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '\\') { current += text[++i] ?? ''; continue }
    if (ch === ' ' || ch === '\t') { push(); continue }
    pending = text.slice(i, i + 2)
    if (OPERATORS.has(pending)) { push(); tokens.push(pending); i++; continue }
    if (OPERATORS.has(ch)) { push(); tokens.push(ch); continue }
    current += ch
  }
  push()
  return { tokens, unterminated: quote !== null }
}

/** Split a token stream into command segments on shell operators. */
function segments(tokens) {
  const out = [[]]
  for (const t of tokens) {
    if (OPERATORS.has(t)) out.push([])
    else out[out.length - 1].push(t)
  }
  return out.filter((s) => s.length > 0)
}

// Flags that consume the following token. Needed so a flag VALUE is never
// mistaken for the verb (`kubectl --context foo get` must read as `get`).
const VALUE_FLAGS = new Set([
  '--context', '--kubeconfig', '--namespace', '-n', '--replicas', '--filename',
  '-f', '--output', '-o', '--selector', '-l', '--server', '--token', '--user',
  '--cluster', '--as', '--as-group', '--image', '--type', '--patch', '-p',
  '--timeout', '--grace-period', '--field-selector', '--container', '-c',
  '--from-literal', '--from-file', '--overrides', '--subresource',
])

const basename = (p) => p.split('/').pop() ?? p
const isEnvAssignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)

/** Read `--flag value` or `--flag=value` from a token list. */
function flag(tokens, name) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === name) return tokens[i + 1]
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1)
  }
  return undefined
}

/**
 * @param {string} command raw shell command as the model wrote it
 * @param {Set<string>} binaries guarded binary basenames, e.g. kubectl, k
 * @returns {{invocations: object[], ambiguous: boolean}}
 */
export function parseCommand(command, binaries) {
  const text = String(command ?? '')
  const mentionsBinary = [...binaries].some((b) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${b}([^A-Za-z0-9_-]|$)`).test(text))

  const { tokens, unterminated } = tokenize(text)
  if (mentionsBinary && (unterminated || OPAQUE.some((re) => re.test(text)))) {
    return { invocations: [], ambiguous: true }
  }

  const invocations = []
  let ambiguous = false

  for (const seg of segments(tokens)) {
    let i = 0
    const env = {}
    while (i < seg.length && isEnvAssignment(seg[i])) {
      const eq = seg[i].indexOf('=')
      env[seg[i].slice(0, eq)] = seg[i].slice(eq + 1)
      i++
    }
    const head = seg[i]
    if (head === undefined || !binaries.has(basename(head))) continue

    const rest = seg.slice(i + 1)
    const positional = []
    for (let j = 0; j < rest.length && positional.length < 2; j++) {
      const t = rest[j]
      if (t.startsWith('-')) {
        if (VALUE_FLAGS.has(t)) j++   // skip this flag's value
        continue
      }
      positional.push(t)
    }
    const [verb, sub] = positional
    if (verb === undefined) { ambiguous = true; continue }

    const replicasRaw = flag(rest, '--replicas')
    const dryRun = flag(rest, '--dry-run')
    invocations.push({
      verb,
      sub,
      context: flag(rest, '--context'),
      kubeconfig: flag(rest, '--kubeconfig'),
      replicas: replicasRaw === undefined ? undefined : Number(replicasRaw),
      // `--dry-run` with no value is the deprecated bare form, still a dry run.
      dryRun: rest.includes('--dry-run') ? 'client' : dryRun,
      prune: rest.includes('--prune'),
      force: rest.includes('--force'),
      // Inline `KUBECONFIG=... kubectl ...` overrides the ambient environment,
      // exactly as the shell would apply it.
      env,
    })
  }

  if (mentionsBinary && invocations.length === 0 && !ambiguous) ambiguous = true
  return { invocations, ambiguous }
}
