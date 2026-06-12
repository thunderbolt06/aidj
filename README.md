# AIDJ Lab

Intent-based music with AI-generated DJ transitions. Every page is an experiment — the goal is to try each idea thoroughly and keep the ones that work.

## Experiments

| Route | Experiment |
|---|---|
| `/mix` | 2-song mix — Claude reads BPM/energy/famous-part of both tracks and renders the transition live |
| `/autodj` | Auto-DJ — plays only the famous part of each song (YouTube "most replayed" heatmap), hops every 30s/60s |
| `/vibe` | Vibe prompt — typed or spoken intent ("singable road trip") → AI builds the queue; vibe change mid-set |
| `/grid` | 9-grid — tap one of nine AI-suggested next songs (safe / energy shift / wildcard) to transition into it |
| `/gestures` | Press-and-hold builds tension, release drops into the next song; swipe up to skip |
| `/karaoke` | Synced lyrics (lrclib) + AI lyric-matched transitions — connects two songs at lyric lines that rhyme/relate |
| `/talkingdj` | MC Fable — Claude writes the banter, OpenAI TTS speaks it ducked over the music, talk back via mic for vibe changes |
| `/mashup` | Two songs layered: A is the low-end bed, B band-passed on top, tempo-matched |

## How it works

- **Source**: YouTube via `yt-dlp` (search, audio extraction, replay heatmap). Audio cached in `.cache/`.
- **Famous part**: the peak of YouTube's "most replayed" heatmap — the bet is people only want ~1 minute of most songs.
- **Analysis**: in-browser BPM detection (lowpass → peak intervals → tempo voting) + per-second energy.
- **Transitions**: Web Audio dual-deck engine — equal-power crossfade, bass swap, filter sweep, echo out, cut; optional beat-matching via playback-rate glide.
- **AI**: Claude plans transitions/queues/banter/lyric matches; OpenAI TTS voices the DJ. Heuristic fallbacks everywhere, so the app works without keys (minus the AI flavor).

## Run it

```bash
brew install yt-dlp ffmpeg
npm install
cp .env.local.example .env.local   # add keys (ANTHROPIC_API_KEY enables the AI features)
npm run dev
```

> **Deployment note**: audio extraction shells out to `yt-dlp`, which does not run on Vercel serverless (and YouTube blocks datacenter IPs). The deployed site is a UI preview; run locally for full functionality, or point `YTDLP_PATH`/the source layer at a self-hosted extractor (Fly.io/Railway box with residential proxy).

## Status / findings log

- [ ] Which transition style feels best per genre?
- [ ] Is the heatmap famous-part reliable for non-music videos / Indian catalog?
- [ ] Does 30s or 60s feel better before boredom?
- [ ] Lyric transitions: gimmick or magic?
