# cc-model-router: design

A Claude Code mod that ranks each prompt by how hard it is and runs the main chat on Haiku, Sonnet or Opus to match.

## Why

Claude Code runs every prompt on the one model picked with `/model`. Most prompts don't need the biggest model. A quick question that runs on Opus burns usage limit and waits longer than it needs to. The owner hits usage limits in practice.

Success means two things:

- Usage limits last longer.
- Easy prompts get faster replies.

Hard work must still get Opus.

## Goals

- Rank every main-chat prompt as **simple**, **medium** or **hard**, and run it on **Haiku**, **Sonnet** or **Opus**.
- Set effort along with the model: Haiku `low`, Sonnet `medium`, Opus `high`. One exception, decided by the owner: Opus keeps the session's effort if it is higher than `high` (`xhigh`, `max`). Hard work never runs weaker than the owner set it.
- Make the decision cheap where it can be. A prefix, a hard rule and a follow-up decide instantly, with no model call. Every other typed prompt is ranked by Haiku and by the rules side by side, and the higher level wins *(changed by the owner after the first build: originally Haiku only broke ties)*.
- Stay **sticky**. A conversation keeps its current model until a clearly new task arrives. Short follow-ups such as "yes do it", "continue" or "ok" never move the model down or sideways. A hard signal always moves it up, even behind "ok". Haiku can also answer `keep` for "same task".
- Let the owner see and steer every decision:
  - **Routed model on screen.** session-info shows the routed model and effort in its line under the prompt, plus `⑂ routed to <model>` above the branch name. The router sets no status entry of its own *(changed after the first build: the `$.ui.status` entry was dropped at the owner's request)*.
  - **Prefix override.** A prompt that starts with `haiku:`, `sonnet:` or `opus:` forces that model. The mod strips the prefix before the prompt is sent. A forced model also becomes the new sticky model.
  - **On/off toggle.** A slash command turns the router on or off for the session. When it's off, the normal `/model` setting applies untouched.
  - **Decision log.** Each decision goes to a file with the time, the tier, the model, the effort, the context size, how it was decided (`prefix`, `rule`, `classifier`, `sticky`, `escalated`), and the reason. A classifier line shows both answers, e.g. `rules: medium/code-change · haiku: simple → medium`. A `step` line is written whenever the model changes between two requests of one turn.

## What counts as hard

These were named by the owner. Each one pushes a prompt to Opus:

- planning or architecture: brainstorms, designs, multi-file plans
- debugging: bugs, failing tests, root-cause hunts
- code changes across many files: features that touch many files
- long pasted context: big logs, docs or code dumps

The exact keywords, length thresholds and medium/simple cut-offs are the builder's call. Medium (Sonnet) covers ordinary single-file code work and moderate questions. Simple (Haiku) covers short questions, lookups, explanations and chat.

## Guards

- **Main chat only.** Subagents keep the model their caller chose. The mod does not hook `agent.spawn`. The `turn.step` hook passes through untouched when `e.agentId` is set.
- **Haiku answers. It doesn't edit.** If a Haiku-routed turn tries to edit files (Edit, Write, NotebookEdit, or a Bash call that writes), that work moves to Sonnet. *As built:* the tool call is denied with a reason, and the following steps and the sticky model move to Sonnet, which retries the edit. Re-sending the step was rejected because it means holding back every Haiku reply until it finishes. Every edit of a Haiku step is judged by the model that step ran on, so a step asking for several edits has all of them denied.
- **Cache awareness.** Switching models throws away the warm prompt cache. Stickiness is the main protection. The builder may also refuse a downgrade while the cache is warm and the context is large.
- **Context window guard** *(builder's call)*. Context over 160k tokens never goes to Haiku. The size comes from a local estimate (`$.session.usage({ breakdown: 'summary' })`), which counts tool results the last response has not seen. An unknown size, as in a fresh session, counts as small. If the session runs a long-context variant (for example `opus[1m]`), a routed Sonnet or Opus keeps that variant.
- **Mid-turn prompts** *(builder's call)*. A prompt typed while a turn is running never re-ranks that turn. Each decision is keyed to the turn it starts. Prompts the owner did not type (`isMeta`, background-task notifications, `/loop` and cron wake-ups, peer messages, prompts from other mods) are not ranked. They stay on the sticky model.
- **Built-in commands** *(builder's call)*. Built-ins that call the model, such as `/compact`, pass through on the sticky model and are never ranked.
- **Failure is safe.** If the rules throw, the classifier call fails or times out, or the log write fails, the prompt goes through on the current sticky model, or on the session's `/model` if there is none. A broken router never blocks a prompt.

## How it works (decided parts)

Built on the mod API in Claude Code 2.1.302, checked again on 2.1.310:

- `prompt.submit`: read the text, strip and apply any prefix, decide the tier, and store the decision for the coming turn. The order: prefix; hard rule; follow-up on a sticky model; Haiku and the rules together (Haiku `keep` keeps the sticky model, otherwise the higher answer wins); and if Haiku fails or takes over 3 seconds, the rules alone with the sticky logic.
- `turn.step` (main loop only): recompute the route with the step's own model, effort and context size, then swap in the routed `model` and `effort` with `next({ ...e, model, effort })`. The session's `/model` setting is never changed.
- `$.model.complete({ model: 'haiku', system, prompt, maxTokens: 5, effort: 'low', timeoutMs: 3000 })` is the classifier. Its system prompt lists the owner's hard categories, what medium and simple mean, and when to answer `keep`. The prompt names the current level and carries the user's text, cut to 4,000 characters.
- `tool.call` holds the Haiku edit guard.
- `session.start` registers `/router` and clears any status entry an earlier version left behind.
- `$.command.register` plus a `command.run` hook handle the on/off toggle.
- `$.fs` writes the decision log.
- `$.state` holds the per-session values, such as the sticky model, whether the router is on, and the last decision. They must survive a mod reload, because a reload resets module variables.

## Where it lives

- Repo: `/Users/ravi/claude-misc/claude-mods` (the owner's `ravi-mods` marketplace, next to `session-info` and `yt-music`).
- Folder: `cc-model-router/`, laid out like `session-info`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts`, `tsconfig.json`.
- Add it to `.claude-plugin/marketplace.json` and the README table and install list. The mod has its own `README.md` covering how it works and setup.

## Change to session-info (decided by the owner)

session-info's line under the prompt currently shows `$.session.model()`, the `/model` setting, which the router never changes. The router publishes its current decision (model, effort, whether it is routed, on or off) in shared state with a declared contract. session-info reads that state when it is present and shows the routed model and effort. When the router is off or not installed, session-info falls back to its current behaviour. With both installed, the owner sees one correct line, not two that disagree. *As built:* session-info reads the router's state with an untyped `$.state.get` and a runtime check, with no `dependencies` entry, so it still loads without the router. It refreshes on `turn.start` so the routed model shows as the turn begins, and draws `⑂ routed to <model>` above the branch name while the router is on and has a pick.

## Non-goals

- Hook ordering between the two mods. session-info reads the router's state and does not depend on which mod's `turn.step` runs first.
- Routing subagents, workflows or `$.model.complete` calls made by other mods.
- Changing the session's `/model` setting.
- Any provider other than Anthropic.
- Learning from history or tuning itself. Rules are hand-written.

## Anti-goals (failure even if it works)

- Hard work, such as a debug, a plan or a multi-file change, ends up on Haiku or Sonnet and comes back worse.
- The model flips back and forth inside one task, burning the cache and costing more than it saves.
- The classifier call blocks or breaks prompts. It adds about 0.5–1.5 seconds and about $0.00003 to most typed prompts, which the owner accepted; it must never stop a prompt, and prefixes, hard rules and follow-ups skip it. *(The original anti-goal was that no easy prompt should pay a classifier call at all; the owner reversed that.)*
- The owner can't tell which model answered, or why.

## Left to the builder

- Rule keywords, length thresholds and how "clearly new task" is detected.
- How slash commands and skills (prompts that arrive with `e.command`) are ranked. Suggested default: rank by the command's name and args, so `/superpowers:brainstorming` counts as planning, which is hard.
- The toggle command's name, and whether it also shows the current state.
- Log path and format. Suggested: one JSON line per decision under the mod's data folder.
- Exact model aliases or ids (aliases `haiku`/`sonnet`/`opus` are fine).
- Tests: none. The owner keeps tests for Zango packages only. The mod is checked with `claude plugin validate`, `tsc` before each push, and live use with the decision log.
