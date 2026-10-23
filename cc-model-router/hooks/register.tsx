import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

import type { Decision, DecisionSource, RouterState, Tier } from '../types'
import { logDecision } from './log'
import { decideAgainstSticky, parsePrefix, rankByRules } from './rank'
import { routeFor } from './route'

const router = atom({ plugin: 'cc-model-router', key: 'router' } as const, { isOn: true, stickyTier: null, decision: null } as RouterState)

const TIERS: readonly Tier[] = ['simple', 'medium', 'hard']

const CLASSIFIER_TIMEOUT_MS = 8000

// Claude Code's own commands: they keep the sticky model and are never ranked.
const BUILT_INS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'exit', 'export', 'fast',
  'help', 'hooks', 'ide', 'init', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin', 'release-notes',
  'reload-plugins', 'resume', 'rewind', 'router', 'status', 'terminal-setup', 'theme', 'usage', 'vim',
])

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// Bash that changes files or history; `2>&1` and `>/dev/null` are not writes.
const WRITING_BASH = /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|tee|sed -i|git (commit|push|checkout|reset|rebase|merge))\b|>>?\s*(?!&|\/dev\/null)[^\s&|;]/

type Verdict = { tier: Tier; source: DecisionSource; reason: string }

// The model the main loop's latest step was sent on: every tool call of a Haiku step is judged by it,
// not by the decision, which the first denied edit already moved to Sonnet.
let stepModel: string | null = null

// Only a Haiku pick needs the size; the local estimate counts tool results the last response has not seen.
async function contextTokens($: EngineInterface): Promise<number | undefined> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)

  return usage?.context.breakdown?.totalTokens ?? usage?.context.tokens
}

// Only what the owner typed, at an idle prompt, is ranked; everything else rides the sticky tier.
const isRankable = (e: PromptSubmitInput): boolean =>
  e.isMeta !== true &&
  e.turnId === undefined &&
  (e.origin.kind === 'composer' || e.origin.kind === 'bridge') &&
  (e.command === undefined || !BUILT_INS.has(e.command.name))

async function classify($: EngineInterface, text: string): Promise<Tier> {
  const timeout = $.clock.sleep(CLASSIFIER_TIMEOUT_MS).then(() => {
    throw new Error('classifier timed out')
  })
  const label = await Promise.race([$.model.classify(text, TIERS, { model: 'haiku' }), timeout])

  return TIERS.find(tier => tier === label) ?? 'medium'
}

async function judge($: EngineInterface, text: string, sticky: Tier | null, command?: { command: string; args: string }): Promise<Verdict> {
  const verdict = rankByRules(text, command)
  const decision = decideAgainstSticky(text, sticky, verdict)

  if (decision.kind === 'switch') {
    return { tier: decision.verdict.tier, source: 'rule', reason: decision.verdict.rule }
  }

  if (decision.kind === 'keep' && sticky !== null) {
    return { tier: sticky, source: 'sticky', reason: verdict === undefined ? 'no clear signal' : `kept over ${verdict.rule}` }
  }

  return { tier: await classify($, text), source: 'classifier', reason: 'rules unsure' }
}

async function decide($: EngineInterface, verdict: Verdict, text: string): Promise<void> {
  const tokens = verdict.tier === 'simple' ? await contextTokens($) : undefined
  const route = routeFor({ tier: verdict.tier, sessionModel: await $.session.model(), contextTokens: tokens })
  const decision: Decision = { ...verdict, tier: route.tier, model: route.model, effort: route.effort, at: await $.clock.now() }

  await update($, router, state => ({ ...state, stickyTier: route.tier, decision }))
  await logDecision($, { ...decision, text })
  $.ui.status(`router: ${route.model}`)
}

function describe(state: RouterState): string {
  const { decision } = state
  const last = decision === null ? 'no decision yet' : `last: ${decision.model} (${decision.source}: ${decision.reason})`

  return `Router ${state.isOn ? 'on' : 'off'} · sticky tier: ${state.stickyTier ?? 'none'} · ${last}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router', description: 'Turn the model router on or off, or show its state' })

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      await update($, router, state => ({ ...state, isOn: arg === 'on' }))
      $.ui.status(arg === 'on' ? undefined : 'router: off')
    } else if (arg !== '' && arg !== 'status') {
      return { text: 'Usage: /router on | off | status' }
    }

    return { text: describe(await read($, router)) }
  })

  // Haiku answers; it does not edit. An edit on a Haiku turn is refused and the turn moves up to Sonnet, which retries it.
  on('tool.call', async ($, e, next) => {
    const state = await read($, router)
    const tool = String(e.tool)
    const isEdit = EDIT_TOOLS.has(tool) || (e.tool === 'Bash' && WRITING_BASH.test(e.command))

    if (e.agentId !== undefined || !state.isOn || !isEdit || stepModel === null || !/haiku/i.test(stepModel)) {
      return next(e)
    }

    const verdict: Verdict = { tier: 'medium', source: 'escalated', reason: `haiku tried ${tool}` }
    await decide($, verdict, tool === 'Bash' && e.tool === 'Bash' ? e.command : tool)

    return { deny: 'Routed up to Sonnet for edits; retry this call.' }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const state = await read($, router)

    if (!state.isOn || !isRankable(e)) {
      return next(e)
    }

    // A command's text is not rewritable, so its prefix is not read.
    const prefix = e.command === undefined ? parsePrefix(e.text) : undefined

    try {
      if (prefix !== undefined) {
        await decide($, { tier: prefix.tier, source: 'prefix', reason: 'prefix' }, e.text)

        return next({ ...e, text: prefix.text })
      }

      const command = e.command === undefined ? undefined : { command: e.command.name, args: e.command.args }
      await decide($, await judge($, e.text, state.stickyTier, command), e.text)
    } catch {
      // Rules or classifier failed: the sticky tier, or the session's model, carries the prompt.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const state = await read($, router)

    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    if (!state.isOn || state.decision === null) {
      stepModel = e.model

      return yield* next(e)
    }

    const tokens = state.decision.tier === 'simple' ? await contextTokens($) : undefined
    const route = routeFor({ tier: state.decision.tier, sessionModel: e.model, sessionEffort: e.effort, contextTokens: tokens })

    if (route.model !== state.decision.model || route.effort !== state.decision.effort || route.tier !== state.decision.tier) {
      await update($, router, current =>
        current.decision === null ? current : { ...current, stickyTier: route.tier, decision: { ...current.decision, ...route } },
      )
      $.ui.status(`router: ${route.model}`)
    }

    // One log line whenever the model a step runs on differs from the step before it.
    if (stepModel !== route.model) {
      await logDecision($, { ...state.decision, ...route, source: 'step', reason: `step ${e.index} of ${e.turnId}: ${stepModel ?? 'none'} -> ${route.model}`, text: '' })
    }

    stepModel = route.model

    return yield* next({ ...e, model: route.model, effort: route.effort ?? e.effort })
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, router, state => ({ ...state, stickyTier: null, decision: null }))
      $.ui.status(undefined)
    }

    return next(e)
  })
}
