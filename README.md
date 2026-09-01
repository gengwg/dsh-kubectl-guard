# dsh-kubectl-guard

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) policy plugin that gates `kubectl` by kubeconfig context.

Irreversible verbs against a non-local cluster are denied outright. Recoverable writes ask first. Reads and local clusters are untouched.

It registers no tools of its own — it inspects the `command` argument of shell tool calls, so it covers whatever the agent runs.

## Install

Requires [pnpm](https://pnpm.io), which `dsh plugin` shells out to.

**From npm:**

```
dsh plugin --profile web add dsh-kubectl-guard
```

**From source**, if you want to hack on it:

```
git clone https://github.com/gengwg/dsh-kubectl-guard
cd dsh-kubectl-guard
dsh plugin --profile web add "$PWD"
```

Either way, activate it in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: kubectl-guard
      name: dsh-kubectl-guard
```

Restart dsh to load it. Installing prints `declares no dsh.bundle — installed
as a plain dependency`; that is expected, since this is a plugin activated by
the patch entry above rather than a profile bundle.

## Examples

Nothing to invoke. Ask the agent to do its normal work; the guard sits in the
tool pipeline and inspects the shell command before it runs.

Blocked, with the cluster name replaced by a per-session pseudonym:

```
> delete the stuck nginx pod

Error: kubectl-guard: 'delete' is irreversible and ctx#4be1 is not a local
cluster. Denied.
```

Asked, so you approve it in the UI before it runs:

```
> roll out the new deployment

kubectl-guard: 'apply' writes to ctx#4be1, which is not a local cluster.
[approve] [deny]
```

Untouched, because reads are not gated:

```
> what pods are failing in kube-system?

kubectl get pods -n kube-system --field-selector=status.phase!=Running
NAME         READY   STATUS             RESTARTS
api-7d9f8c   0/1     CrashLoopBackOff   14
```

Untouched, because the context is local:

```
> wipe the test namespace on my kind cluster

kubectl --context kind-dev delete ns test
namespace "test" deleted
```

Dry runs are reads, so they pass and give the agent a way to show you a change
before asking for it:

```
kubectl apply --dry-run=server -f deploy.yaml     # allowed
kubectl apply -f deploy.yaml                      # asks
```

Turn the guard off for one session without editing config:

```
dsh web --patch <(echo '- id: kubectl-guard
  disabled: true')
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
