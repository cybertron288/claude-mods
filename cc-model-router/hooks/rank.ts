import type { Tier } from '../types'

export type RuleVerdict = { tier: Tier; rule: string }

export type StickyDecision = { kind: 'keep' } | { kind: 'switch'; verdict: RuleVerdict } | { kind: 'ask' }

const PREFIX = /^\s*(haiku|sonnet|opus):\s*/i

const PREFIX_TIERS: Record<string, Tier> = { haiku: 'simple', sonnet: 'medium', opus: 'hard' }

const FOLLOW_UP = /^(y|yes|yep|ok|okay|sure|go|go ahead|do it|continue|proceed|next|lgtm|looks good|thanks|thank you|nice|great|done)\b/i

// The owner's hard cases, first match wins.
const HARD_RULES: readonly { rule: string; test: (text: string) => boolean }[] = [
  { rule: 'long-paste', test: text => text.length > 4000 || text.split('\n').length > 80 },
  { rule: 'planning', test: text => /\b(plan|brainstorm|architect(ure)?|design|refactor|migrat(e|ion)|rfc|spec)\b/i.test(text) },
  {
    rule: 'debugging',
    test: text =>
      /\b(debug|bug|broken|crash(es|ing)?|stack ?trace|traceback|exception|failing|fails?|regression|root cause|why (is|does|doesn'?t))\b/i.test(text),
  },
  {
    rule: 'multi-file',
    test: text => /\b(across|all|every|multiple|several) (files?|modules?|components?|packages?)\b/i.test(text) || /\bcodebase\b/i.test(text),
  },
]

const CODE_CHANGE = /\b(add|implement|write|create|update|change|rename|edit|modify|fix|remove|delete)\b/i

const QUESTION_START = /^(what|how|where|which|who|when|is|are|can|does|do|explain|show|list)\b/i

const HARD_COMMAND = /brainstorm|plan|architect|debug|review/i

// The minimum length a prompt needs to count as a clearly new task rather than an aside.
const NEW_TASK_LENGTH = 60

export function parsePrefix(text: string): { tier: Tier; text: string } | undefined {
  const match = PREFIX.exec(text)
  const tier = match === null ? undefined : PREFIX_TIERS[match[1]!.toLowerCase()]

  return tier === undefined ? undefined : { tier, text: text.slice(match![0].length) }
}

export function isFollowUp(text: string): boolean {
  const trimmed = text.trim()

  return trimmed.length <= 40 && FOLLOW_UP.test(trimmed)
}

export function rankByRules(text: string, command?: { command: string; args: string }): RuleVerdict | undefined {
  if (command !== undefined && HARD_COMMAND.test(command.command)) {
    return { tier: 'hard', rule: 'command' }
  }

  const subject = command === undefined ? text : `${command.command} ${command.args}`
  const hard = HARD_RULES.find(({ test }) => test(subject))

  if (hard !== undefined) {
    return { tier: 'hard', rule: hard.rule }
  }

  if (CODE_CHANGE.test(subject)) {
    return { tier: 'medium', rule: 'code-change' }
  }

  const trimmed = subject.trim()
  const isShortQuestion = trimmed.length <= 200 && !trimmed.includes('\n') && (trimmed.endsWith('?') || QUESTION_START.test(trimmed))

  return isShortQuestion ? { tier: 'simple', rule: 'short-question' } : undefined
}

export function decideAgainstSticky(text: string, sticky: Tier | null, verdict: RuleVerdict | undefined): StickyDecision {
  if (sticky === null) {
    return verdict === undefined ? { kind: 'ask' } : { kind: 'switch', verdict }
  }

  if (verdict === undefined || verdict.tier === sticky) {
    return { kind: 'keep' }
  }

  // A hard signal always moves up, even behind "ok"; a follow-up only blocks moving down or sideways.
  if (verdict.tier === 'hard') {
    return { kind: 'switch', verdict }
  }

  if (!isFollowUp(text) && text.trim().length >= NEW_TASK_LENGTH) {
    return { kind: 'switch', verdict }
  }

  return { kind: 'keep' }
}
