import type { Effort, Tier } from '../types'

export type RouteInput = { tier: Tier; sessionModel: string; sessionEffort?: Effort | number; contextTokens?: number }

export type Route = { tier: Tier; model: string; effort?: Effort }

// Haiku's window is 200k; past this the context no longer fits it with room to answer.
export const HAIKU_CONTEXT_LIMIT = 160_000

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const MODELS: Record<Tier, string> = { simple: 'haiku', medium: 'sonnet', hard: 'opus' }

const EFFORTS: Record<Tier, Effort> = { simple: 'low', medium: 'medium', hard: 'high' }

// Opus never runs weaker than the session's own effort; a numeric budget counts as none.
const opusEffort = (session: Effort | number | undefined): Effort =>
  typeof session === 'string' && EFFORT_ORDER.indexOf(session) > EFFORT_ORDER.indexOf('high') ? session : 'high'

export function routeFor({ tier, sessionModel, sessionEffort, contextTokens }: RouteInput): Route {
  // An unknown size (a fresh session has none yet) counts as small; a known one past the limit never goes to Haiku.
  const fits = tier !== 'simple' || (contextTokens ?? 0) <= HAIKU_CONTEXT_LIMIT
  const routed: Tier = fits ? tier : 'medium'
  const isLong = /\[1m\]/i.test(sessionModel) && routed !== 'simple'

  return {
    tier: routed,
    model: isLong ? `${MODELS[routed]}[1m]` : MODELS[routed],
    effort: routed === 'hard' ? opusEffort(sessionEffort) : EFFORTS[routed],
  }
}
