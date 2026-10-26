# cc-model-router

A Claude Code mod that picks the model for each prompt. It ranks every prompt you type as **simple**, **medium** or **hard**, and runs it on **Haiku**, **Sonnet** or **Opus** to match. Easy prompts answer faster and use less of your limits. Hard work still gets Opus.

Your `/model` setting is never changed. The router swaps the model on each request to the API, so `/model` and the model picker still show your own setting.

## Setup

### From GitHub

```
/plugin marketplace add cybertron288/claude-mods
/plugin install cc-model-router@ravi-mods
/plugin install session-info@ravi-mods
```

Then run `/reload-plugins`, or start a new session. A session that was already open when you installed the mod does not route until it reloads.

session-info is optional. It shows the routed model and effort in the line under the prompt, and a `⑂ routed to <model>` line above the branch name. Without session-info the router still works, but you can only see its picks with `/router status` and in the log.

### From a local folder (while developing)

```
claude --plugin-dir /path/to/claude-mods/cc-model-router --plugin-dir /path/to/claude-mods/session-info
```

## How it works

Each prompt you type goes through these steps. The first step that decides wins.

1. **Prefix.** A prompt that starts with `haiku:`, `sonnet:` or `opus:` uses that model. The prefix is removed before the prompt is sent.
2. **Hard rule.** These prompts go to Opus at once, with no classifier call:
   - long pastes (more than 4,000 characters or 80 lines)
   - planning words (plan, brainstorm, design, architecture, refactor, migrate, spec)
   - debugging words (bug, failing, crash, exception, stack trace, root cause, "why does…")
   - many-file work ("across all files", "every component", "codebase")
   - slash commands whose name contains brainstorm, plan, architect, debug or review
3. **Follow-up.** A short reply like "yes", "ok", "do it" or "continue" stays on the current model.
4. **Haiku and the rules.** For every other prompt, Haiku reads the prompt and answers `simple`, `medium`, `hard` or `keep`. It is told the hard categories above and the level in use now. At the same time the rules give their own answer:
   - **medium:** words that ask for a code change (add, implement, fix, update, rename, remove…)
   - **simple:** a short question on one line
   - **unsure:** anything else

   Haiku's `keep` means "same task", so the current model stays. Otherwise the higher of the two answers wins, so hard work does not drop by mistake.
5. **Fallback.** If Haiku fails or takes more than 3 seconds, the rules decide alone. A sticky model stays unless the rules see a hard signal, or a new task of 60+ characters at a different level.

### Levels, models and effort

| Level | Model | Effort |
|---|---|---|
| simple | Haiku | low |
| medium | Sonnet | medium |
| hard | Opus | high, or your session effort if that is higher (`xhigh`, `max`) |

### Guards

- **Main chat only.** Subagents keep the model their caller chose.
- **Haiku does not edit.** If a Haiku turn tries Edit, Write, NotebookEdit or a Bash command that writes (`rm`, `mv`, `git commit`, `> file`…), the call is refused and the chat moves up to Sonnet, which tries the edit again.
- **Large context.** Context over 160k tokens never goes to Haiku.
- **Long-context sessions.** If your `/model` is a `[1m]` variant, Sonnet and Opus keep the `[1m]` variant.
- **Not ranked:** prompts typed while a turn is running, background notifications, `/loop` and cron wake-ups, prompts sent by other mods, and Claude Code's own commands (`/compact`, `/clear`, `/model`…). These stay on the current model.
- **Failure is safe.** If ranking fails in any way, the prompt goes through on the current model, or on your `/model` setting.

## Commands

| Command | What it does |
|---|---|
| `/router` or `/router status` | Shows on or off, the current level, and the last pick with its reason |
| `/router off` | Stops routing. Everything runs on your `/model` setting |
| `/router on` | Starts routing again |

`/clear` resets the current level, so the next prompt is ranked fresh.

## Log

Each decision is written to `~/.claude/cc-model-router/decisions.jsonl`, one JSON line per decision. The last 1,000 lines are kept.

```json
{"tier":"medium","source":"classifier","reason":"rules: medium/code-change · haiku: simple → medium","model":"sonnet","effort":"medium","at":"2026-10-26T06:30:00.000Z","contextTokens":42000,"text":"add a loading spinner to the save button"}
```

| `source` | Meaning |
|---|---|
| `prefix` | You forced a model with `haiku:`, `sonnet:` or `opus:` |
| `rule` | A hard rule decided, or the rules decided because Haiku failed |
| `classifier` | Haiku and the rules decided together; `reason` shows both answers |
| `sticky` | A follow-up, or Haiku failed, so the current model stayed |
| `escalated` | Haiku tried to edit, so the chat moved up to Sonnet |
| `step` | The model changed between two requests inside one turn |

All sessions write to the same file.

Read the latest picks:

```
tail -5 ~/.claude/cc-model-router/decisions.jsonl
```

## Cost

The Haiku classifier costs about $0.00003 per prompt, roughly 3 cents per 1,000 prompts. Prefixes, follow-ups and hard-rule prompts make no call. It adds about 0.5 to 1.5 seconds before the other prompts are sent.

## Tuning

- The rules, the follow-up words and the 60-character "new task" length are in `hooks/rank.ts`.
- The classifier's instructions and the 3-second timeout are in `hooks/register.tsx` (`CLASSIFIER_SYSTEM`, `CLASSIFIER_TIMEOUT_MS`).
- The level → model → effort table and the 160k Haiku limit are in `hooks/route.ts`.

Read the log to see where the rules and Haiku disagree before you change them.

## Files

| File | Holds |
|---|---|
| `hooks/register.tsx` | The hooks: ranking on submit, the model swap on each request, the Haiku edit guard, `/router` |
| `hooks/rank.ts` | Prefixes, follow-ups, the rules and the sticky logic |
| `hooks/route.ts` | Level → model and effort, the context and `[1m]` guards |
| `hooks/log.ts` | The decision log |
| `types/index.d.ts` | The shared state that session-info reads |
| `docs/design.md`, `docs/plan.md` | The original design and build plan |
