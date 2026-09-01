// Stable per-process pseudonym for a context name.
//
// The point is that model-facing text -- which leaves the machine for the LLM
// provider -- never carries an internal cluster name, while still letting the
// model tell two clusters apart within a session. The salt is random per
// process, so ids are stable for a session and not guessable from a name.

import { createHash, randomBytes } from 'node:crypto'

const salt = randomBytes(16)

export function pseudonym(context) {
  if (!context) return 'ctx#unresolved'
  const h = createHash('sha256').update(salt).update(context).digest('hex')
  return `ctx#${h.slice(0, 4)}`
}

/** @param {boolean} reveal when true, show the real name (opt-in). */
export function label(context, reveal) {
  if (reveal) return context ?? '<unresolved>'
  return pseudonym(context)
}
