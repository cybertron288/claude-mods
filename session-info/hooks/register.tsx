import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Info, Meter } from '../types'

const infoAtom = atom({ plugin: 'session-info', key: 'info' } as const, null)

const windowLabel = (tokens: number): string =>
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`

// `five_hour` reads as `5h`, `seven_day` as `7d`; any other kind as its own name.
const limitLabel = (kind: string): string => {
  const name = kind.toLowerCase()

  return name.includes('five') ? '5h' : name.includes('seven') || name.includes('week') ? '7d' : name.replace(/_/g, ' ')
}

const bar = (percent: number, width = 8): string => {
  const filled = Math.round((percent / 100) * width)

  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

// Gruvbox, to match the skin.
const COLORS = { accent: '#fabd2f', warn: '#fe8019', err: '#fb4934', model: '#8ec07c', effort: '#d3869b', window: '#83a598', branch: '#b8bb26', muted: '#928374' }

const meterColor = (percent: number): string => (percent >= 95 ? COLORS.err : percent >= 80 ? COLORS.warn : COLORS.accent)

// The last effort a model request carried; none before the first.
let effort: string | null = null

// The effort `/effort` set, as the /config menu holds it: for the first turn, before any
// model request has said which effort it ran at.
async function configuredEffort($: EngineInterface): Promise<string | null> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find(r => /effort/i.test(r.key) || /effort/i.test(r.label))

  return row === undefined || row.value === null || row.value === undefined || row.value === '' ? null : String(row.value)
}

async function refresh($: EngineInterface): Promise<void> {
  const [model, usage, git] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.process.run(['git', 'branch', '--show-current']).catch(() => null),
  ])
  const branch = git !== null && git.exitCode === 0 ? git.stdout.trim() || null : null
  const status = branch === null ? null : await $.process.run(['git', 'status', '--porcelain']).catch(() => null)
  const dirty = status !== null && status.exitCode === 0 && status.stdout.trim() !== ''
  const meters: Meter[] = [
    ...(usage.context.percent == null ? [] : [{ label: 'ctx', percent: usage.context.percent }]),
    ...usage.rateLimits.map(limit => ({ label: limitLabel(limit.kind), percent: limit.percentUsed })),
  ].map(meter => ({ ...meter, percent: Math.max(0, Math.min(100, Math.round(meter.percent))) }))
  const next: Info = { model, effort: effort ?? (await configuredEffort($)), window: usage.context.window || null, branch, dirty, meters }
  const prev = await read($, infoAtom)

  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await update($, infoAtom, () => next)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined) {
      effort = String(e.effort)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  // One line under the prompt hint: usage meters and model on the left, the branch at the right edge.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const info = await read($, infoAtom)
    const theirs = await next(e)

    if (info === null) {
      return theirs
    }

    const { Box, Text } = $.ui.resolve(e)
    const parts = [
      { text: info.model, color: COLORS.model },
      info.effort === null ? null : { text: info.effort, color: COLORS.effort },
      info.window === null ? null : { text: `${windowLabel(info.window)} ctx`, color: COLORS.window },
    ].filter((part): part is { text: string; color: string } => part !== null)

    return (
      <Box flexDirection="column">
        {theirs}
        <Box width="100%" justifyContent="space-between">
          <Box>
            {info.meters.map(meter => (
              <Text key={meter.label}>
                <Text color={COLORS.muted}>{`${meter.label} `}</Text>
                <Text color={meterColor(meter.percent)}>{bar(meter.percent)}</Text>
                <Text color={COLORS.muted}>{` ${meter.percent}%  `}</Text>
              </Text>
            ))}
            {parts.map(part => (
              <Text key={part.text}>
                <Text color={COLORS.muted}>{'·  '}</Text>
                <Text color={part.color}>{`${part.text}  `}</Text>
              </Text>
            ))}
          </Box>
          {info.branch === null ? null : (
            <Text>
              <Text color={COLORS.branch}>{`⎇ ${info.branch}`}</Text>
              {info.dirty ? <Text color={COLORS.warn}>{'*'}</Text> : null}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
