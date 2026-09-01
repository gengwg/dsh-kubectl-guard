# dsh-kubectl-guard

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) policy plugin that gates `kubectl` by kubeconfig context.

Irreversible verbs against a non-local cluster are denied outright. Recoverable writes ask first. Reads and local clusters are untouched.

It registers no tools of its own — it inspects the `command` argument of shell tool calls, so it covers whatever the agent runs.

## Install

```
dsh plugin --profile web add dsh-kubectl-guard
```

Then add it to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: kubectl-guard
      name: dsh-kubectl-guard
```

## Behavior

| Command | Non-local context | Local context |
|---|---|---|
| `get`, `describe`, `logs`, `top` | allow | allow |
| `apply`, `patch`, `scale`, `exec` | ask | allow |
| `delete`, `drain`, `evict` | deny | allow |
| `scale --replicas=0` | deny | allow |
| `apply --dry-run=server` | allow | allow |

A context is local only if it matches `localContexts`. Everything else, including a kubeconfig that cannot be read, is treated as production.

## Config

```yaml
config:
  localContexts: [minikube, 'kind-*', docker-desktop]
  binaries: [kubectl, k]
  guardedTools: [bash]
  showContextNames: false
```

`showContextNames` is off by default: blocked-command messages go to the model, and therefore to the LLM provider. With it off the model sees a stable per-session pseudonym like `ctx#4be1` instead of your cluster's name.

## Failing closed

A gate that can be talked around is worse than none. Anything unparseable — `sh -c`, command substitution, an unterminated quote — is treated as a mutation: denied if the text contains an irreversible verb, asked otherwise. An unknown verb asks rather than allows.

## Limitations

- Only `kubectl`. helm, argocd and flux are not covered; the verb table is data, so adding them is an edit to `src/verbs.js`.
- `current-context` is read with a line-anchored regex, not a YAML parser. Unreadable or unmatched means production, so the failure direction is safe.
- The pseudonym salt is per-process: ids are stable within a session, not across restarts.
- Guards are synchronous, so the deny path does no I/O beyond a cached `readFileSync`.

## Test

```
npm test
```

MIT.
