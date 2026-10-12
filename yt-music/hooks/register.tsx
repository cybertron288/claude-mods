import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Track } from '../types'

const trackAtom = atom({ plugin: 'yt-music', key: 'track' } as const, null as Track | null)

const POLL_MS = 2000
const SEEK_SECONDS = 10

// Runs `js` in the first Chrome tab on music.youtube.com and answers what it returns,
// '' when Chrome holds no such tab. The script reaches osascript as an argument, so it
// needs no AppleScript escaping.
const RUN_IN_TAB = [
  'on run argv',
  'tell application "Google Chrome"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'if URL of t contains "music.youtube.com" then return execute t javascript (item 1 of argv)',
  'end repeat',
  'end repeat',
  'end tell',
  'return ""',
  'end run',
]

const READ_JS = `(() => {
  const v = document.querySelector('video'), m = navigator.mediaSession.metadata
  if (!v || !m) return ''
  return JSON.stringify({ title: m.title, artist: m.artist, isPaused: v.paused, seconds: v.currentTime, duration: v.duration || 0 })
})()`

// Presses the player's own control by its label: the new player (ytmusic-wiz-player-controls)
// first, the older player bar after. Carousels on the page carry Next and Previous too.
const pressControl = (label: string): string =>
  `document.querySelector('ytmusic-wiz-player-controls [aria-label="${label}"], ytmusic-player-bar [aria-label="${label}"]')?.click()`

const ACTIONS = {
  toggle: `(v => v.paused ? v.play() : v.pause())(document.querySelector('video'))`,
  next: pressControl('Next'),
  previous: pressControl('Previous'),
  back: `(v => { v.currentTime = Math.max(0, v.currentTime - ${SEEK_SECONDS}) })(document.querySelector('video'))`,
  forward: `(v => { v.currentTime = v.currentTime + ${SEEK_SECONDS} })(document.querySelector('video'))`,
} as const

// Single-width glyphs: the emoji media symbols (⏮ ⏸ ⏭) draw two columns wide in most
// terminals, which shifts the spacing and the hover highlight off the button.
const CONTROLS: readonly (readonly [keyof typeof ACTIONS, string])[] = [
  ['previous', '|◂'],
  ['back', '◂◂'],
  ['toggle', '▸'],
  ['forward', '▸▸'],
  ['next', '▸|'],
]

const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds))

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Gruvbox, to match the skin.
const COLORS = { note: '#fb4934', title: '#fabd2f', played: '#b8bb26', muted: '#928374' }

const filledOf = (seconds: number, duration: number, width: number): number =>
  duration > 0 ? Math.min(width, Math.round((seconds / duration) * width)) : 0

const played = (seconds: number, duration: number, width = 16): string => '━'.repeat(filledOf(seconds, duration, width))

const left = (seconds: number, duration: number, width = 16): string => '─'.repeat(width - filledOf(seconds, duration, width))

async function runInTab($: EngineInterface, js: string): Promise<string | null> {
  // Asking Chrome while it is closed would launch it.
  const chrome = await $.process.run(['pgrep', '-x', 'Google Chrome']).catch(() => null)

  if (chrome === null || chrome.exitCode !== 0) {
    return null
  }

  const ran = await $.process.run(['osascript', ...RUN_IN_TAB.flatMap(line => ['-e', line]), js]).catch(() => null)

  return ran !== null && ran.exitCode === 0 ? ran.stdout.trim() : null
}

async function refresh($: EngineInterface): Promise<void> {
  const out = await runInTab($, READ_JS)
  let track: Track | null = null

  if (out !== null && out !== '' && out !== 'missing value') {
    try {
      track = JSON.parse(out) as Track
    } catch {
      track = null
    }
  }

  if (JSON.stringify(await read($, trackAtom)) !== JSON.stringify(track)) {
    await update($, trackAtom, () => track)
  }
}

async function press($: EngineInterface, action: keyof typeof ACTIONS): Promise<void> {
  await runInTab($, ACTIONS[action])
  await refresh($)
}

let poller: { cancel: () => void } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => void refresh($))
    await refresh($)

    return result
  })

  on('session.end', ($, e, next) => {
    poller?.cancel()
    poller = null

    return next(e)
  })

  // Under the prompt, after the engine's own hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const track = await read($, trackAtom)
    const theirs = await next(e)

    if (track === null) {
      return theirs
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {theirs}
        <Box>
          <Text color={COLORS.note}>♪ </Text>
          <Text bold color={COLORS.title}>{track.title}</Text>
          <Text color={COLORS.muted}>{` - ${track.artist}  `}</Text>
          {CONTROLS.map(([action, label]) => (
            <Button plain key={action} label={` ${action === 'toggle' && !track.isPaused ? '‖' : label} `} onPress={() => press($, action)} />
          ))}
          <Text color={COLORS.muted}>{`  ${clock(track.seconds)} `}</Text>
          <Text color={COLORS.played}>{played(track.seconds, track.duration)}</Text>
          <Text color={COLORS.muted}>{`${left(track.seconds, track.duration)} ${clock(track.duration)}`}</Text>
        </Box>
      </Box>
    )
  })
}
