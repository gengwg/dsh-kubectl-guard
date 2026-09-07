import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide } from '../src/decide.js'
import { _clearCache } from '../src/resolver.js'

// Synthetic names only. Nothing here names a real cluster.
const PROD_CONTEXT = 'orbital-badger-prod'

const dir = mkdtempSync(join(tmpdir(), 'kguard-'))
const kubeconfig = join(dir, 'config')
writeFileSync(kubeconfig, `apiVersion: v1\nkind: Config\ncurrent-context: ${PROD_CONTEXT}\n`)
const env = { KUBECONFIG: kubeconfig }

const cfg = {
  localContexts: ['minikube', 'kind-*'],
  binaries: ['kubectl', 'k'],
  guardedTools: ['bash'],
  showContextNames: false,
}

const cases = [
  ['read is allowed',                 'kubectl get pods',                          'allow'],
  ['irreversible is denied',          'kubectl delete pod web-1',                  'deny'],
  ['drain is denied',                 'kubectl drain node-3',                      'deny'],
  ['write asks',                      'kubectl apply -f deploy.yaml',              'ask'],
  ['patch asks',                      'kubectl patch deploy web -p "{}"',          'ask'],
  ['scale to zero is denied',         'kubectl scale --replicas=0 deploy/web',     'deny'],
  ['scale up only asks',              'kubectl scale --replicas=3 deploy/web',     'ask'],
  ['dry run is a read',               'kubectl apply --dry-run=server -f d.yaml',  'allow'],
  ['local context is exempt',         'kubectl --context minikube delete ns foo',  'allow'],
  ['kind glob is exempt',             'kubectl --context kind-dev delete pod x',   'allow'],
  ['non-kubectl is untouched',        'ls -la && echo done',                       'allow'],
  ['piped write still asks',          'cat d.yaml | kubectl apply -f -',           'ask'],
  ['alias is covered',                'k delete pod x',                            'deny'],
  ['opaque wrapper + delete denies',  'bash -c "kubectl delete ns foo"',           'deny'],
  ['command substitution asks',       'kubectl apply -f $(mktemp)',                'ask'],
  ['unknown verb asks',               'kubectl frobnicate widget',                 'ask'],
  ['chained: worst wins',             'kubectl get po && kubectl delete po x',     'deny'],
  ['apply --prune deletes, so deny',  'kubectl apply --prune -f d.yaml',           'deny'],
  ['replace --force deletes, so deny','kubectl replace --force -f d.yaml',         'deny'],
  ['plain replace only asks',         'kubectl replace -f d.yaml',                 'ask'],
  ['auth can-i reads',                'kubectl auth can-i get pods',                'allow'],
  ['auth reconcile writes RBAC',      'kubectl auth reconcile -f rbac.yaml',        'ask'],
  // Variable indirection: the binary never appears as a bare token, so the
  // parser must fall back to treating the whole command as opaque.
  ['aliased binary via $VAR',         'K=kubectl; $K delete pod foo',               'deny'],
  ['whole command in a variable',     'CMD="kubectl delete"; $CMD pod foo',         'deny'],
  ['braced expansion is opaque too',  'kubectl ${VERB} pod foo',                    'ask'],
  // pflag applies the LAST occurrence of a repeated flag; the parser must too.
  ['last --dry-run wins',             'kubectl apply -f d.yaml --dry-run=client --dry-run=none', 'ask'],
  ['last --context wins',             'kubectl delete pod x --context minikube --context prod-eu', 'deny'],
  ['last --replicas wins',            'kubectl scale deploy/web --replicas=3 --replicas=0', 'deny'],
  // pflag stops at `--`: later tokens are the remote command, not kubectl flags.
  ['flags after -- are not kubectl flags', 'kubectl exec prod-pod -- ./runbook.sh --dry-run', 'ask'],
  ['context after -- does not exempt', 'kubectl exec prod-pod -- ./migrate.sh --context minikube', 'ask'],
  // `use-context` retargets the session, so it asks even against a local
  // ambient context — and a chained delete then asks as well.
  ['use-context asks',                'kubectl config use-context prod-eu',         'ask'],
  ['config view still reads',         'kubectl config view',                        'allow'],
  // `use-context` retargets the session, so it asks even against a local
  // ambient context — see the dedicated chain test below, which needs a local
  // kubeconfig to prove the delete no longer slips through pre-switch.
  // --server/--token bypass the kubeconfig, so its context vouches for nothing.
  ['--server cannot hide behind local kubeconfig', 'kubectl --server https://10.0.0.5:6443 --token t delete pod x', 'deny'],
]

for (const [title, command, expected] of cases) {
  test(title, () => {
    _clearCache()
    assert.equal(decide(command, cfg, env).action, expected, command)
  })
}

test('unresolvable kubeconfig is treated as production', () => {
  _clearCache()
  assert.equal(decide('kubectl delete pod x', cfg, { KUBECONFIG: join(dir, 'missing') }).action, 'deny')
})

test('context name never reaches model-facing text by default', () => {
  _clearCache()
  for (const command of ['kubectl delete pod x', 'kubectl apply -f d.yaml']) {
    const { reason } = decide(command, cfg, env)
    assert.ok(!reason.includes(PROD_CONTEXT), `leaked context name in: ${reason}`)
    assert.match(reason, /ctx#[0-9a-f]{4}/)
  }
})

test('opt-in reveals the real name', () => {
  _clearCache()
  const { reason } = decide('kubectl delete pod x', { ...cfg, showContextNames: true }, env)
  assert.ok(reason.includes(PROD_CONTEXT))
})

test('use-context chain: delete resolved pre-switch no longer slips through', () => {
  _clearCache()
  const localConfig = join(dir, 'local-chain')
  writeFileSync(localConfig, 'apiVersion: v1\nkind: Config\ncurrent-context: minikube\n')
  // Ambient context is local: pre-fix, the delete was judged against minikube
  // and allowed, while at runtime the switch happens first. Now use-context
  // itself asks, surfacing the whole chain for approval.
  const verdict = decide('kubectl config use-context prod-eu && kubectl delete pod x', cfg, { KUBECONFIG: localConfig })
  assert.equal(verdict.action, 'ask')
})

test('inline KUBECONFIG cannot smuggle a production context past a local shell', () => {
  _clearCache()
  const localConfig = join(dir, 'local')
  writeFileSync(localConfig, 'apiVersion: v1\nkind: Config\ncurrent-context: minikube\n')
  // Ambient env points somewhere harmless; the command redirects it inline.
  const verdict = decide(`KUBECONFIG=${kubeconfig} kubectl delete pod x`, cfg, { KUBECONFIG: localConfig })
  assert.equal(verdict.action, 'deny')
})

test('inline KUBECONFIG pointing at a local cluster is still exempt', () => {
  _clearCache()
  const localConfig = join(dir, 'local2')
  writeFileSync(localConfig, 'apiVersion: v1\nkind: Config\ncurrent-context: minikube\n')
  const verdict = decide(`KUBECONFIG=${localConfig} kubectl delete pod x`, cfg, { KUBECONFIG: kubeconfig })
  assert.equal(verdict.action, 'allow')
})
