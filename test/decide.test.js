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
