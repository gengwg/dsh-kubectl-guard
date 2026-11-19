# dsh-kubectl-guard

## Validation and coverage

- Use Node `>=20` as declared in `package.json`. Run `npm test`, which executes `node --test test/*.test.js`; CI runs the same script on **Node 22** via `.github/workflows/test.yml`, after `npm install` pulls the declared peer dependencies that `test/index.test.js` needs.
- Tests must remain offline: use synthetic context names, temporary synthetic kubeconfigs, and explicitly injected environment objects. Do not read a developer's real kubeconfig or contact/run against a live cluster.
- `test/decide.test.js` covers `decide()`; `test/index.test.js` covers Cordis registration, hook ordering, guarded-tool filtering, and return-value mapping in `src/index.js` with fakes. Extend the isolated Cordis-hook tests when changing that wiring; a passing decision table alone does not verify the plugin is enforced.

## Decision flow and invariants

`src/index.js` wires configuration and hooks. `src/decide.js` orchestrates `matcher.js` (shell parsing) → `resolver.js` (context resolution) → `classifier.js` (local vs production) and `verbs.js` (risk tier), with `redact.js` for model-facing labels.

Preserve these fail-closed rules:

- Verdict precedence is **deny > ask > allow**, and a chained shell command keeps its worst invocation's verdict. Unknown verbs ask outside local contexts. Opaque/ambiguous guarded commands ask, or deny when their text contains an irreversible verb.
- Only an explicit `localContexts` glob match is local. Unknown, missing, unreadable, or `--server`/`--token`-overridden contexts are production.
- The production-deny hook is `ctx.tools.guard()` and must remain synchronous: it returns the denial reason, and every operation on that path (including cached kubeconfig reads) must remain synchronous. Recoverable writes use the `tools/pre-execute` ask hook; guard denial still wins.
- Dry runs are reads, but repeated flags use the last value and `--dry-run=none` is not a dry run. A local-context exemption must never allow a mutating `kubectl config` subcommand: those rewrite/retarget kubeconfig and must ask even for local contexts.
- Keep `scale --replicas=0`, `apply --prune`, and `replace --force` irreversible outside local contexts; distinguish `auth can-i` from mutating `auth reconcile`.

## Parser regressions and privacy

Add table regressions in `test/decide.test.js` for parser, resolver, and verdict changes, including both a bypass attempt and a benign control where applicable. Cover relevant edges: quotes/operators and non-command mentions; `sh -c`, substitution/expansion, and wrappers; value-taking flags; last repeated `--context`, `--dry-run`, and `--replicas`; `--` termination; inline `KUBECONFIG` precedence; config-use-context chains; missing files; and chained worst-verdict selection. Preserve documented wrapper limitations rather than silently weakening ambiguity handling.

Model-facing errors are sent to the LLM provider. Keep context names pseudonymized by default and assert non-disclosure in tests; only explicit `showContextNames: true` may reveal them. Put no real cluster identifiers or credentials in fixtures.

## Package boundary

`package.json`'s `files` allowlist adds only `src/` and `cordis.patch.yml` to npm's automatically included package metadata, README, and license. Keep runtime modules under `src/`, retain the bundle patch, and keep tests/development-only files out of the allowlist; deliberately review any package-content change.
