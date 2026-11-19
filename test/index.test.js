import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { _clearCache } from '../src/resolver.js'

const PROD_CONTEXT = 'orbital-badger-prod'
const dir = mkdtempSync(join(tmpdir(), 'kguard-index-'))
const kubeconfig = join(dir, 'config')
writeFileSync(kubeconfig, `apiVersion: v1\nkind: Config\ncurrent-context: ${PROD_CONTEXT}\n`)

const cfg = {
  localContexts: ['minikube', 'kind-*'],
  binaries: ['kubectl', 'k'],
  guardedTools: ['bash'],
  showContextNames: false,
}
const delegated = Symbol('delegated')
const next = async () => delegated

function cordis(overrides = {}) {
  const registrations = []
  const guards = []
  const listeners = new Map()
  const ctx = {
    tools: {
      guard(fn) {
        registrations.push('guard')
        guards.push(fn)
      },
    },
    on(event, fn) {
      registrations.push(event)
      listeners.set(event, [...(listeners.get(event) || []), fn])
    },
  }
  apply(ctx, { ...cfg, ...overrides })
  return { registrations, guards, preExecute: listeners.get('tools/pre-execute') || [] }
}

function exec(command, name = 'bash') {
  return { name, arguments: { command } }
}

function prod(command) {
  return `KUBECONFIG=${kubeconfig} ${command}`
}

beforeEach(() => _clearCache())

test('apply registers one synchronous guard and one pre-execute listener in order', () => {
  const { registrations, guards, preExecute } = cordis()
  assert.deepEqual(registrations, ['guard', 'tools/pre-execute'])
  assert.equal(guards.length, 1)
  assert.equal(preExecute.length, 1)
})

test('production delete maps to a synchronous guard denial without leaking the context', async () => {
  const { guards, preExecute } = cordis()
  const call = exec(prod('kubectl delete pod web-1'))
  const denial = guards[0](call)
  assert.equal(typeof denial, 'string')
  assert.match(denial, /Denied\.$/)
  assert.match(denial, /ctx#[0-9a-f]{8}/)
  assert.ok(!denial.includes(PROD_CONTEXT), denial)
  assert.equal(await preExecute[0](call, next), delegated)
})

test('production apply maps to pre-execute ask and no guard denial', async () => {
  const { guards, preExecute } = cordis()
  const call = exec(prod('kubectl apply -f deploy.yaml'))
  assert.equal(guards[0](call), undefined)
  const result = await preExecute[0](call, next)
  assert.equal(result.kind, 'ask')
  assert.match(result.reason, /'apply' writes to ctx#[0-9a-f]{8}/)
  assert.ok(!result.reason.includes(PROD_CONTEXT), result.reason)
})

test('a production secret dump maps to pre-execute ask, not a denial', async () => {
  const { guards, preExecute } = cordis()
  const call = exec(prod('kubectl get secret db -o yaml'))
  assert.equal(guards[0](call), undefined)
  const result = await preExecute[0](call, next)
  assert.equal(result.kind, 'ask')
  assert.match(result.reason, /prints secret values from ctx#[0-9a-f]{8}/)
  assert.ok(!result.reason.includes(PROD_CONTEXT), result.reason)
})

test('reads and non-kubectl commands delegate through both hooks', async () => {
  const { guards, preExecute } = cordis()
  for (const command of [prod('kubectl get pods'), 'ls -la && echo done']) {
    const call = exec(command)
    assert.equal(guards[0](call), undefined)
    assert.equal(await preExecute[0](call, next), delegated)
  }
})

test('guardedTools ignores an unlisted shell and honors pwsh', async () => {
  const { guards, preExecute } = cordis({ guardedTools: ['pwsh'] })
  const ignored = exec(prod('kubectl delete pod web-1'))
  assert.equal(guards[0](ignored), undefined)
  assert.equal(await preExecute[0](ignored, next), delegated)

  const guarded = exec(prod('kubectl delete pod web-1'), 'pwsh')
  assert.match(guards[0](guarded), /Denied\.$/)
  const ask = exec(prod('kubectl apply -f deploy.yaml'), 'pwsh')
  assert.equal((await preExecute[0](ask, next)).kind, 'ask')
})

test('missing or malformed arguments pass through unchanged', async () => {
  const { guards, preExecute } = cordis()
  const calls = [
    { name: 'bash' },
    { name: 'bash', arguments: null },
    { name: 'bash', arguments: 'kubectl delete pod web-1' },
    { name: 'bash', arguments: { command: 42 } },
  ]
  for (const call of calls) {
    assert.equal(guards[0](call), undefined)
    assert.equal(await preExecute[0](call, next), delegated)
  }
})

test('a chained apply and delete remains deny after pre-execute', async () => {
  const { guards, preExecute } = cordis()
  const call = exec(`${prod('kubectl apply -f deploy.yaml')} && ${prod('kubectl delete pod web-1')}`)
  const early = await preExecute[0](call, next)
  assert.equal(early, delegated)
  const final = early === delegated ? guards[0](call) : early
  assert.equal(typeof final, 'string')
  assert.match(final, /'delete' is irreversible/)
})
