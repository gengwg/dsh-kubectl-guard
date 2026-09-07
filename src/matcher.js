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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Wrappers that prepend a command without changing what it does. Seeing one
// as a segment head means "keep looking", not "give up".
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'sudo', 'doas', 'command', 'builtin', 'exec', 'stdbuf', 'setsid', 'chrt', 'ionice', 'taskset', 'timeout', 'xargs'])

// Wrapper flags that consume the following token, so the value is not
// mistaken for the command (`sudo -u root kubectl ...`). Most wrapper flags
// take no value (-n, -p, -v, --signal, --preserve-env, ...); these do.
const WRAPPER_VALUE_FLAGS = new Set(['-n', '--nice', '-u', '--user', '-g', '--group', '-C', '--chdir'])

/**
 * Read `--flag value` or `--flag=value` from a token list. pflag applies the
 * LAST occurrence of a repeated flag, so we keep scanning: reading the first
 * would let `--dry-run=client --dry-run=none` pass as a dry run.
 */
function flag(tokens, name) {
  let value
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === name) { value = tokens[i + 1]; i++; continue }
    if (t.startsWith(`${name}=`)) value = t.slice(name.length + 1)
  }
  return value
}

/**
 * @param {string} command raw shell command as the model wrote it
 * @param {Set<string>} binaries guarded binary basenames, e.g. kubectl, k
 * @returns {{invocations: object[], ambiguous: boolean}}
 */
export function parseCommand(command, binaries) {
  const text = String(command ?? '')
  const mentionsBinary = [...binaries].some((b) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(b)}([^A-Za-z0-9_-]|$)`).test(text))

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
    // See through pass-through wrappers (`sudo kubectl ...`, `time k ...`).
    // Flags are skipped (WRAPPER_VALUE_FLAGS consume one value); the scan
    // stops at the first bare token, which is the command — or another
    // wrapper, continuing the chain. A wrapper argument that is a bare token
    // (`timeout 30 ...`) ends the chain and the segment is skipped: a gap,
    // but a fail-open one only for that specific composition.
    while (i < seg.length && WRAPPERS.has(basename(seg[i]))) {
      i++
      while (i < seg.length && seg[i].startsWith('-')) {
        if (WRAPPER_VALUE_FLAGS.has(seg[i])) i++   // skip this flag's value
        i++
      }
      while (i < seg.length && isEnvAssignment(seg[i])) i++
    }
    const head = seg[i]
    if (head === undefined || !binaries.has(basename(head))) continue

    // pflag stops flag parsing at `--`; for exec/cp, everything after it is
    // the remote command line, not kubectl flags.
    const afterDashDash = seg.slice(i + 1)
    const dd = afterDashDash.indexOf('--')
    const rest = dd === -1 ? afterDashDash : afterDashDash.slice(0, dd)
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
      // --server/--token bypass the kubeconfig entirely; any context the
      // resolver reads would describe the wrong cluster, so report none.
      serverOverride: flag(rest, '--server') !== undefined || flag(rest, '--token') !== undefined,
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

  // A bare binary token as a segment head that yielded no invocation is
  // opaque. A mere mention in a non-head position (`grep -rn "kubectl
  // delete" runbooks/`) is not — reading about kubectl mutates nothing.
  if (!ambiguous && invocations.length === 0) {
    const bareHead = segments(tokens).some((seg) => {
      let i = 0
      while (i < seg.length && isEnvAssignment(seg[i])) i++
      return i < seg.length && binaries.has(basename(seg[i]))
    })
    if (bareHead) ambiguous = true
  }
  return { invocations, ambiguous }
}
