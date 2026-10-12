# claude-mods

My personal Claude Code mods. Each one is tuned for my own setup and taste: the macOS + Google Chrome stack, a gruvbox palette and the layout of my terminal. They are shared as they are. Use them, fork them, but expect to change them to fit your setup.

One directory per mod.

| Mod | Description |
|-----|-------------|
| [yt-music](./yt-music) | YT Music in Chrome under the prompt: track, time, play/pause, previous and next |
| [session-info](./session-info) | Usage meters, model, effort, context window and git branch in one line under the prompt |

## Assumptions

- **yt-music:** macOS only. It drives Google Chrome through `osascript`, so Chrome needs "Allow JavaScript from Apple Events" turned on (View → Developer). It reads the first tab open on music.youtube.com.
- **session-info:** runs `git` in the session's working directory. Colors are hard-coded gruvbox.

## Install

```
/plugin marketplace add cybertron288/claude-mods
/plugin install yt-music@ravi-mods
/plugin install session-info@ravi-mods
```
