# cc-model-router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that ranks each main-chat prompt simple/medium/hard and runs it on Haiku/Sonnet/Opus with matching effort, sticky across a task, visible in session-info, overridable and logged.

**Architecture:** Pure functions (`rank.ts`, `route.ts`) hold every decision; `register.tsx` wires them to `prompt.submit` (decide), `turn.step` (apply model + effort), `tool.call` (Haiku edit guard), `command.run` (toggle) and `$.state` (shared decision). session-info reads the router's state to show the routed model.

**Tech Stack:** Claude Code function-hooks API (build 2.1.302), TypeScript/TSX, `claude-code/testing` kit, `claude plugin validate` / `claude plugin test`.

**Spec:** `cc-model-router/docs/design.md` (read it first).

**API reference:** `/private/tmp/claude-501/bundled-skills/2.1.302/eb5400bb4c022b6cbea14c7c7a737004/plugin-authoring/types/claude-code.d.ts` (grep by event name) and `reference.md` beside it. Once the mod has loaded once, the same types sit in `cc-model-router/.claude-plugin/types/`. Model the file layout on `session-info/`.

## Status: built, and changed after review and use

All seven tasks shipped (PR #5, merged). The tasks below are the plan as it was written. Where the build went another way, this list is the record. The code and `design.md` are current.

**Changes made while building**
- **Tests.** No tests were written or run. The owner keeps tests for Zango packages only. Each task was checked with `claude plugin validate`, and `tsc` ran before each push.
- **Task 2: unknown context size.** It counts as small, so Haiku can be picked in a fresh session. The 160k limit applies to a known size only. (The first build treated unknown as too big, which kept every simple prompt off Haiku.)
- **Task 3: follow-ups.** A hard verdict switches even after a follow-up word ("ok now debug the crash"). A follow-up only blocks moving down or sideways.
- **Task 4: route recomputed on each step.** `turn.step` recomputes the route with the step's model, effort and context size, and updates the stored decision when it differs. Context size comes from `$.session.usage({ breakdown: 'summary' })`, a local estimate that counts tool results.
- **Task 5: edit guard.** Uses deny-and-escalate, not re-sending the step, so Haiku replies still stream. Edits are judged by the model the step ran on (`stepModel`), not by the decision. The Bash write check ignores `2>&1` and `>/dev/null`.
- **Task 6: session-info dependency.** session-info has no `dependencies` entry. It reads the router's state untyped, with a runtime check, so it loads without the router. The branch was rebased onto `session-info-bars-effort` (PR #4).

**Changes the owner asked for after release**
- **Step log.** A `step` line is logged whenever the model changes between two requests in one turn.
- **Status line.** The router no longer sets `$.ui.status`. It clears any leftover entry at `session.start`. session-info draws `⑂ routed to <model>` above the branch name instead.
- **Haiku classifier on every typed prompt.** It runs alongside the rules, replacing the tie-breaker in Task 4:
  - A prefix, a hard rule, or a follow-up on a sticky model decides with no call.
  - Otherwise `$.model.complete` on `haiku` (low effort, 5 tokens, 3-second timeout, a system prompt with the hard categories and the current level) answers `simple`, `medium`, `hard` or `keep`.
  - `keep` keeps the sticky tier. Otherwise the higher of Haiku and the rules wins.
  - If Haiku fails, the rules and the sticky logic decide alone.
  - The log reason shows both answers. Each decision also logs `contextTokens`.
- **README.** `cc-model-router/README.md` covers how it works and setup (PR #6).

## Global Constraints

- Repo `/Users/ravi/claude-misc/claude-mods`, branch `cc-model-router`. Commit as `cybertron288 <ravi60353@gmail.com>`. No attribution trailer in commits or PR. Never push to `main`; push the branch and open a PR.
- Main chat only: every hook passes through untouched when `e.agentId` is set. Never hook `agent.spawn`.
- Never change the session's `/model` setting; override per request in `turn.step` only.
- Tiers → models: simple → `haiku`, medium → `sonnet`, hard → `opus`.
- Effort: haiku `low`, sonnet `medium`, opus `max(high, session effort)` on the order `low < medium < high < xhigh < max`.
- Prefixes `haiku:`, `sonnet:`, `opus:` (case-insensitive, at the very start) force the model, are stripped from the text, and set the sticky tier.
- Router off → no rewrite anywhere; `/model` applies.
- Any failure (rules throw, classifier fails/times out, log write fails) → current sticky tier, else no rewrite. The router never drops a prompt; `prompt.submit` hooks always end in `next(...)`.
- **Owner's verification rule:** tests, `tsc` and builds run **only immediately before pushing** (Task 7). Write each task's tests with the task but do not run them per task. `claude plugin validate cc-model-router` is a load check, not a test, and may run after each task. Live behaviour is checked by loading the mod in a Claude Code session (hot reload) and watching the session-info line and the log.

## Review Focus

1. A follow-up like "yes do it" after an Opus planning prompt must stay on Opus → test `follow-up keeps sticky opus` (Task 3).
2. A prompt typed mid-turn (`e.turnId` set) or a non-human origin (`origin.kind` not `composer`/`bridge`, or `isMeta`) must not re-rank → test `mid-turn and notification prompts keep sticky tier` (Task 4).
3. Large context must never be routed to Haiku → test `no haiku above context guard` (Task 2).
4. A Haiku turn that tries Edit/Write must not complete the edit on Haiku → test `haiku edit is denied and turn escalates to sonnet` (Task 5).
5. A classifier that throws must not block the prompt → test `classifier failure falls back to sticky` (Task 4).

---

## File Structure

```
cc-model-router/
  .claude-plugin/plugin.json      manifest, "types": "./types/index.d.ts"
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/rank.ts                   pure: prefix, follow-up, rules ranking
  hooks/route.ts                  pure: tier → { model, effort }, guards
  hooks/log.ts                    decision log (read + rewrite JSONL, capped)
  hooks/register.tsx              wiring: events, state, command, status
  types/index.d.ts                Tier, Decision, RouterState + PluginState
  tsconfig.json                   copy of session-info/tsconfig.json
  tests/rank.test.ts
  tests/route.test.ts
  tests/router.test.ts
  docs/design.md, docs/plan.md
session-info/hooks/register.tsx   read router state (Task 6)
session-info/.claude-plugin/plugin.json, session-info/types/index.d.ts
.claude-plugin/marketplace.json, README.md
```

---

### Task 1: Scaffold and state contract

**Files:**
- Create: `cc-model-router/.claude-plugin/plugin.json`, `cc-model-router/hooks/hooks.json`, `cc-model-router/hooks/register.tsx` (empty `register`), `cc-model-router/types/index.d.ts`, `cc-model-router/tsconfig.json`

**Interfaces:**
- Produces (in `types/index.d.ts`):
  ```ts
  export type Tier = 'simple' | 'medium' | 'hard'
  export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  export type DecisionSource = 'prefix' | 'rule' | 'classifier' | 'sticky' | 'escalated'
  export type Decision = { tier: Tier; model: string; effort?: Effort; source: DecisionSource; reason: string; at: number }
  export type RouterState = { isOn: boolean; stickyTier: Tier | null; decision: Decision | null }
  declare module 'claude-code' {
    interface PluginState { 'cc-model-router': { router: RouterState } }
  }
  ```
- One atom only: `{ plugin: 'cc-model-router', key: 'router' }`, initial `{ isOn: true, stickyTier: null, decision: null }`. Every later task reads/writes this one value.

- [ ] **Step 1:** Write the five files. `plugin.json`: `{ "name": "cc-model-router", "version": "0.1.0", "description": "Routes each prompt to Haiku, Sonnet or Opus by how hard it is", "types": "./types/index.d.ts" }`.
- [ ] **Step 2:** Run `claude plugin validate cc-model-router`. Expected: no refusals.
- [ ] **Step 3:** Commit `cc-model-router: scaffold and state contract`.

---

### Task 2: Routing table and guards (`route.ts`)

**Files:**
- Create: `cc-model-router/hooks/route.ts`
- Test: `cc-model-router/tests/route.test.ts`

**Interfaces:**
- Consumes: `Tier`, `Effort` from `../types`.
- Produces:
  ```ts
  export type RouteInput = { tier: Tier; sessionModel: string; sessionEffort?: Effort | number; contextTokens?: number }
  export type Route = { tier: Tier; model: string; effort?: Effort }
  export function routeFor(input: RouteInput): Route
  export const HAIKU_CONTEXT_LIMIT = 160_000
  ```

- [ ] **Step 1: Write tests** in `tests/route.test.ts` (import `test`, `expect` from `claude-code/testing`):
  - `simple → haiku low`: `routeFor({ tier: 'simple', sessionModel: 'claude-opus-5-5' })` → `{ tier: 'simple', model: 'haiku', effort: 'low' }`
  - `medium → sonnet medium` → `{ model: 'sonnet', effort: 'medium' }`
  - `hard → opus high`: sessionEffort `'medium'` → `effort: 'high'`
  - `opus keeps higher session effort`: sessionEffort `'max'` → `effort: 'max'`; `'xhigh'` → `'xhigh'`
  - `numeric session effort leaves opus at high`: sessionEffort `32000` → `'high'`
  - `no haiku above context guard`: `{ tier: 'simple', contextTokens: 170_000 }` → `{ tier: 'medium', model: 'sonnet', effort: 'medium' }`
  - `1m variant kept`: sessionModel `'opus[1m]'`, tier hard → model `'opus[1m]'`; tier medium → `'sonnet[1m]'`; tier simple with `contextTokens: 10_000` → `'haiku'`
- [ ] **Step 2: Implement `routeFor`** in `hooks/route.ts`. A `[1m]` suffix anywhere in `sessionModel` (case-insensitive) carries to sonnet/opus. The context guard bumps simple to medium when `contextTokens > HAIKU_CONTEXT_LIMIT`.
- [ ] **Step 3:** Commit `cc-model-router: tier to model and effort routing`.

---

### Task 3: Ranking rules (`rank.ts`)

**Files:**
- Create: `cc-model-router/hooks/rank.ts`
- Test: `cc-model-router/tests/rank.test.ts`

**Interfaces:**
- Consumes: `Tier` from `../types`.
- Produces:
  ```ts
  export function parsePrefix(text: string): { tier: Tier; text: string } | undefined
  export function isFollowUp(text: string): boolean
  export type RuleVerdict = { tier: Tier; rule: string }
  export function rankByRules(text: string, command?: { command: string; args: string }): RuleVerdict | undefined
  export type StickyDecision = { kind: 'keep' } | { kind: 'switch'; verdict: RuleVerdict } | { kind: 'ask' }
  export function decideAgainstSticky(text: string, sticky: Tier | null, verdict: RuleVerdict | undefined): StickyDecision
  ```

Rule values (starting point; tune later, keep tests green):
- **hard** (first match wins, `rule` names it):
  - `long-paste`: more than 4000 chars or more than 80 lines
  - `planning`: /\b(plan|brainstorm|architect(ure)?|design|refactor|migrat(e|ion)|rfc|spec)\b/i
  - `debugging`: /\b(debug|bug|broken|crash(es|ing)?|stack ?trace|traceback|exception|failing|fails?|regression|root cause|why (is|does|doesn'?t))\b/i
  - `multi-file`: /\b(across|all|every|multiple|several) (files?|modules?|components?|packages?)\b/i or `/\bcodebase\b/i`
- **medium**: `code-change`: /\b(add|implement|write|create|update|change|rename|edit|modify|fix|remove|delete)\b/i (and no hard rule fired)
- **simple**: `short-question`: ≤ 200 chars, single line, ends with `?` or starts with /^(what|how|where|which|who|when|is|are|can|does|do|explain|show|list)\b/i, and no medium/hard rule fired
- otherwise `undefined` (unsure).
- **Commands:** when `command` is given, rank `` `${command.command} ${command.args}` `` with the same rules, and any command whose name contains `brainstorm`, `plan`, `architect`, `debug` or `review` is hard by `rule: 'command'`.
- **Follow-up:** trimmed text ≤ 40 chars matching /^(y|yes|yep|ok|okay|sure|go|go ahead|do it|continue|proceed|next|lgtm|looks good|thanks|thank you|nice|great|done)\b/i.
- **`decideAgainstSticky`:** sticky `null` → verdict ? switch : ask. Follow-up → keep. Verdict hard and sticky not hard → switch (upgrade). Verdict present, text ≥ 60 chars, verdict tier ≠ sticky → switch (clearly new task). Everything else → keep. Never `ask` while a sticky tier exists.

- [ ] **Step 1: Write tests** in `tests/rank.test.ts`:
  - `prefix forces and strips`: `parsePrefix('Opus: plan the cache')` → `{ tier: 'hard', text: 'plan the cache' }`; `parsePrefix('the opus: thing')` → `undefined`
  - `rules rank the owner's hard cases`: "brainstorm a router for prompts" → hard/planning; "tests are failing after the merge, find the root cause" → hard/debugging; "rename userId across all files" → hard/multi-file; a 5000-char paste → hard/long-paste
  - `medium and simple`: "add a loading spinner to the save button" → medium/code-change; "what does useMemo do?" → simple/short-question; "hmm" → `undefined`
  - `skill commands rank by name`: `rankByRules('', { command: 'superpowers:brainstorming', args: 'x' })` → hard/command
  - `follow-up keeps sticky opus`: `decideAgainstSticky('yes do it', 'hard', rankByRules('yes do it'))` → `{ kind: 'keep' }`
  - `hard signal upgrades sticky`: sticky `'simple'`, text "now debug why the build crashes" → switch hard
  - `short off-topic stays`: sticky `'hard'`, text "what is a mutex?" → keep
  - `long new task switches down`: sticky `'hard'`, a ≥ 60-char "what is the difference between a mutex and a semaphore in plain words?" → switch simple
  - `no sticky and unsure asks`: sticky `null`, verdict `undefined` → `{ kind: 'ask' }`
- [ ] **Step 2: Implement** the five exports in `hooks/rank.ts`, using the rule values above.
- [ ] **Step 3:** Commit `cc-model-router: prompt ranking rules and stickiness`.

---

### Task 4: Wiring — decide on submit, apply on step, log, status

**Files:**
- Create: `cc-model-router/hooks/log.ts`
- Modify: `cc-model-router/hooks/register.tsx`
- Test: `cc-model-router/tests/router.test.ts`

**Interfaces:**
- Consumes: `routeFor` (Task 2); `parsePrefix`, `rankByRules`, `decideAgainstSticky`, `isFollowUp` (Task 3); the `router` atom (Task 1).
- Produces: `export async function logDecision($: EngineInterface, d: Decision & { text: string }): Promise<void>` in `log.ts`. It writes to `${HOME}/.claude/cc-model-router/decisions.jsonl` (HOME from `$.env.get('HOME')`; never inside the plugin folder, which would hot-reload), one JSON line per decision with `text` cut to 200 chars, and keeps the last 1000 lines (read, append, rewrite with `$.fs.write`). It swallows its own errors.

Behaviour in `register.tsx`:
- **`prompt.submit`:** pass through unchanged when the router is off, `e.command` names a Claude Code built-in (no `:` in the name and not registered by a plugin: at least `compact`, `clear`, `model`, `config`, `cost`, `context`, `help`), `e.isMeta`, `e.turnId` is set, or `e.origin.kind` is not `composer`/`bridge`. Otherwise, in order: prefix → `next({ ...e, text: stripped })`, source `prefix`. Then `decideAgainstSticky`: keep → source `sticky`; switch → source `rule`; ask → `$.model.classify(text, ['simple','medium','hard'], { model: 'haiku' })` with an 8 s timeout, source `classifier`, and `medium` when it answers `undefined`. Store `{ stickyTier, decision }` in the atom, log it, and call `$.ui.status(\`router: ${model}\`)`. Wrap all of it so any throw ends in `next(e)` with the last sticky tier left in place. Register with `.catch(($, e, next) => next(e))` so the prompt is never dropped.
- **`turn.step`** (async generator): pass through when `e.agentId` is set, the router is off, or there is no decision. Otherwise read `contextTokens` from `(await $.session.usage()).context.tokens`, then `routeFor(...)` with `sessionModel = e.model` and `sessionEffort = e.effort`, then `yield* next({ ...e, model, effort })`. When the decision's `effort` is undefined, leave `e.effort`.
- **`session.end` with `reason: 'clear'`:** reset `stickyTier` and `decision` to null (keep `isOn`).

- [ ] **Step 1: Write tests** in `tests/router.test.ts`. Beneath the plugin, the test's own `on('turn.step', ...)` records the `model`/`effort` it receives; `on('model.classify', ...)` answers or throws; `on('fs.write', ...)` records writes; `on('session.usage', ...)` returns a small context.
  - `hard prompt runs on opus high`: `$.prompt.submit({ text: 'brainstorm a router', origin: { kind: 'composer' } })`, then raise `$.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })` → recorded `{ model: 'opus', effort: 'high' }`
  - `prefix wins and is stripped`: submit "haiku: plan everything" → the text reaching beneath is "plan everything" and the step model is `haiku`
  - `subagent steps pass through`: step with `agentId: 'a1'` → recorded model is the step's own
  - `mid-turn and notification prompts keep sticky tier`: after a hard prompt, submit "what is x?" with `turnId: 't1'`, then one with a non-composer origin → sticky stays hard, no classifier call
  - `unsure prompt asks the classifier once`: "hmm" with no sticky → classifier called once, its answer `'medium'` → step model `sonnet`
  - `classifier failure falls back to sticky`: classifier throws, sticky `'hard'` → prompt goes through, step model `opus`; with no sticky → step model unchanged
  - `decision is logged`: one `fs.write` whose last line parses to a Decision with `source` and `reason`
- [ ] **Step 2: Implement** `log.ts` and the hooks above in `register.tsx`.
- [ ] **Step 3:** `claude plugin validate cc-model-router`. Expected: hooks `prompt.submit`, `turn.step`, `session.end` listed; `prompt.submit` shown as a gating hook with `.catch`.
- [ ] **Step 4: Live check:** with hot reload on, send "what does git stash do?" then "brainstorm a cache layer" then "yes do it". Expected log tiers: simple/rule, hard/rule, hard/sticky; status shows `router: haiku` then `router: opus`.
- [ ] **Step 5:** Commit `cc-model-router: route prompts on submit and apply per step`.

---

### Task 5: Haiku edit guard and on/off command

**Files:**
- Modify: `cc-model-router/hooks/register.tsx`
- Test: `cc-model-router/tests/router.test.ts` (add)

**Interfaces:**
- Consumes: the `router` atom and `Decision` (Task 1); `routeFor` (Task 2).

**Edit guard (my call, see handoff note).** The design preferred re-sending the step on Sonnet. That means buffering every Haiku step before it can stream, which costs the speed the router exists to win. This plan instead uses a `tool.call` guard:
- **`tool.call`** for `Edit`, `Write`, `NotebookEdit`, and `Bash` whose command matches /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|git (commit|push|checkout|reset|rebase|merge)|sed -i|tee)\b|>>?/ — only when `e.agentId` is unset and the current decision's model is `haiku`. It sets the decision to `{ ...decision, tier: 'medium', source: 'escalated', reason: 'haiku tried <tool>' }`, sets `stickyTier: 'medium'`, logs it, and returns `{ deny: 'Routed up to Sonnet for edits; retry this call.' }`. The next `turn.step` of the same turn then runs on Sonnet, which retries.
- Register with `.catch(($, e, next) => next(e))`. A broken guard must never block a tool.

**Command:** `$.command.register({ name: 'router', description: 'Turn the model router on or off, or show its state' })` in `session.start`. A `command.run` hook matched to `router`: args `on` / `off` set `isOn`; empty or `status` answers. The answer is `{ text }` naming on/off, the sticky tier, and the last decision's model, source and reason.

- [ ] **Step 1: Write tests:**
  - `haiku edit is denied and turn escalates to sonnet`: after a simple prompt, `$.tool.call({ tool: 'Edit', ... })` resolves errored with the deny text; the following `turn.step` records `sonnet`; the log has an `escalated` line
  - `sonnet edit passes`: the same Edit under a medium decision is not denied
  - `read-only bash on haiku passes`: Bash `git status` is not denied; Bash `echo x > f` is denied
  - `router off restores /model`: `$.command.run({ command: 'router', args: 'off' })`, then a hard prompt → the step model is unchanged; `router on` resumes
  - `router status names state`: the `status` text contains `on`, the tier and the model
- [ ] **Step 2: Implement** the guard and the command.
- [ ] **Step 3:** `claude plugin validate cc-model-router`. Expected: `command.run` "answers its own command: router".
- [ ] **Step 4: Live check:** "haiku: create a file /tmp/x.txt saying hi". Expected: one denied Write, then the retry on Sonnet succeeds and the log shows `escalated`. `/router off` → the session-info line shows the `/model` model again.
- [ ] **Step 5:** Commit `cc-model-router: haiku edit guard and /router command`.

---

### Task 6: session-info shows the routed model

**Prerequisite:** session-info's current code is on the unmerged branch `session-info-bars-effort` (commit `36625d6`). Before this task, `git rebase origin/main` if that PR has merged. Otherwise rebase this branch onto `session-info-bars-effort` and say so in the PR body.

**Files:**
- Modify: `session-info/hooks/register.tsx` (`refresh`), `session-info/.claude-plugin/plugin.json`, `session-info/types/index.d.ts` (only if the `Info` shape changes)

**Interfaces:**
- Consumes: `$.state.get({ plugin: 'cc-model-router', key: 'router' })` → `{ value?: RouterState }`.
- Typing: add `"dependencies": ["cc-model-router"]` to session-info's `plugin.json` so the engine lays the router's contract into its types. **Verify first** with `claude plugin validate session-info`, and by loading session-info without the router, that a missing dependency does not stop session-info from loading. If it does, drop the dependency and read the value as `unknown`, narrowing it at runtime with a small type guard in session-info.

- [ ] **Step 1:** In `refresh`, read the router state. When `value?.isOn` and `value.decision` exist, show `decision.model` in place of `$.session.model()`, and the decision's `effort` (if any) in place of the tracked effort. Otherwise keep today's behaviour exactly. A read that throws counts as absent.
- [ ] **Step 2:** Make the line refresh after the router decides: session-info already refreshes on `turn.complete`. Also refresh on `turn.start` (main loop only) so the routed model shows as the turn begins.
- [ ] **Step 3:** Validate both mods.
- [ ] **Step 4: Live check:** with both loaded, a simple then a hard prompt flips the line from `haiku … low` to `opus … high`. With `/router off`, the line shows the `/model` value. Ask the owner to confirm the line looks right; this is a display change.
- [ ] **Step 5:** Commit `session-info: show the router's model and effort when it is on`.

---

### Task 7: Register, document, verify, push

**Files:**
- Modify: `.claude-plugin/marketplace.json` (add `{"name": "cc-model-router", "source": "./cc-model-router", "description": "Routes each prompt to Haiku, Sonnet or Opus by how hard it is"}`), `README.md` (table row, assumptions line: "main chat only; logs to `~/.claude/cc-model-router/decisions.jsonl`; pairs with session-info", install line `/plugin install cc-model-router@ravi-mods`)

- [ ] **Step 1:** Edit both files.
- [ ] **Step 2: Pre-push verification** (the only test/type-check run):
  - `claude plugin test cc-model-router` → all tests pass
  - `claude plugin test session-info` (if it has tests) → pass
  - `bunx tsc -p cc-model-router` and `bunx tsc -p session-info` → no errors
  - `claude plugin validate cc-model-router` and `claude plugin validate session-info` → no refusals
  Fix any failure before continuing.
- [ ] **Step 3:** Commit `cc-model-router: add to marketplace and README`.
- [ ] **Step 4:** `git push -u origin cc-model-router`, then `gh pr create` (no attribution footer). Give the owner the link.
