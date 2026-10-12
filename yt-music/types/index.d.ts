export type Track = { title: string; artist: string; isPaused: boolean; seconds: number; duration: number }

declare module 'claude-code' {
  interface PluginState {
    'yt-music': { track: Track | null }
  }
}
