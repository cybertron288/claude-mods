import type { EngineInterface } from 'claude-code'

import type { Decision } from '../types'

const KEEP_LINES = 1000

// Outside the plugin folder: a write inside it would hot-reload the mod.
async function logPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home === undefined ? undefined : `${home}/.claude/cc-model-router/decisions.jsonl`
}

export async function logDecision($: EngineInterface, decision: Decision & { text: string }): Promise<void> {
  try {
    const path = await logPath($)

    if (path === undefined) {
      return
    }

    const line = JSON.stringify({ ...decision, at: new Date(decision.at).toISOString(), text: decision.text.slice(0, 200) })
    const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const lines = [...previous.split('\n').filter(Boolean), line].slice(-KEEP_LINES)

    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // The log is a convenience; a failed write never touches routing.
  }
}
