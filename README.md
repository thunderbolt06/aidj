# Everplay Lab

Intent-based music with AI-generated DJ transitions. Every page is an experiment , the goal is to try each idea thoroughly and keep the ones that work.

## Experiments

| Route | Experiment |
|---|---|
| `/mix` | 2-song mix , Claude reads BPM/energy/famous-part of both tracks and renders the transition live |
| `/autodj` | Auto-DJ , plays only the hook of each song (detected from the audio), hops every 30s/60s |
| `/vibe` | Vibe prompt , typed or spoken intent ("singable road trip") → AI builds the queue; vibe change mid-set |
| `/grid` | 9-grid , tap one of nine AI-suggested next songs (safe / energy shift / wildcard) to transition into it |
| `/gestures` | Press-and-hold builds tension, release drops into the next song; swipe up to skip |
| `/karaoke` | Synced lyrics (lrclib) + AI lyric-matched transitions , connects two songs at lyric lines that rhyme/relate |
| `/talkingdj` | MC Fable , Claude writes the banter, OpenAI TTS speaks it ducked over the music, talk back via mic for vibe changes |
| `/mashup` | Two songs layered: A is the low-end bed, B band-passed on top, tempo-matched |
| `/reels` | Vertical swipe feed of famous parts , swiping to the next card IS the transition (phrase-quantized); feed refills itself with AI suggestions |
| `/pads` | FX pad , risers, impacts, horns and beat loops over the live mix; loops lock to the track's tempo and bar |
| `/library` | The crate , browse by genre / tempo / key, with licence and source for every track |
| `/bridge` | Generated bridge , Claude writes the brief, Replicate MusicGen composes a ~10s clip from A's world into B's, rendered while A plays |

**Beat-grid quantize**: transitions can wait for the next 4-bar phrase boundary (toggle on Auto-DJ, always on in Reels) and snap the incoming track onto its own beat grid instead of firing on raw timers.

## How it works

- **Source**: a local, pre-built **library** (`library/`, git-ignored) instead of live YouTube extraction. Songs come from the Free Music Archive dataset (Creative Commons, English + instrumental, most-listened first); FX one-shots and beat loops from a synthesized kit and Freesound CC0. Nothing is fetched from a third party while you listen, so nothing can be blocked or rate-limited mid-set.
- **Precomputed attributes**: at ingest every entry gets BPM + confidence, beat/downbeat grid, key (Camelot), per-second energy, loudness, an intensity score, intro/outro cue points and a hook estimate. The app serves them with the track - the browser only downloads and decodes.
- **Famous part**: the hook is detected from the audio - the section that is both loud and *recurs* (chroma self-similarity), taking its first occurrence. The seekbar heatmap is that same curve.
- **Picking what plays next**: tempo / key / genre / intensity matching over the catalog - instant, no LLM round-trip, and every pick is guaranteed playable. Claude is still used to turn a typed vibe into a library filter, and to plan transitions.
- **Transitions**: Web Audio dual-deck engine - equal-power crossfade, bass swap, filter sweep, echo out, cut; optional beat-matching via playback-rate glide.
- **AI**: Claude plans transitions/vibe filters/banter; OpenAI TTS voices the DJ. Heuristic fallbacks everywhere, so the app works without keys.

## Build the library

```bash
brew install ffmpeg                      # python3 + node 22 also required
npm install
npm run library:kit                      # built-in FX + drum loops (synthesized, instant)
npm run library:fetch -- --limit 3000    # top-N CC tracks from Free Music Archive (resumable)
npm run library:ingest                   # analyze + index everything downloaded
npm run dev
```

| Command | What it does |
|---|---|
| `library:fetch` | Reads the 880 GB FMA archive's index over HTTP and downloads only the selected tracks' byte ranges. `--genres Rock,Pop`, `--commercial` (commercial-use licences only), `--allow-nd`, `--dry-run`. The host is slow (~30 tracks/min); re-run to resume. |
| `library:grow` | Second FMA pass: `library:fetch --untagged` (tracks with no language tag, most-listened first; `FMA_LIMIT`, default 20500 total) with an ingest every 10 minutes. Log: `library/logs/fma-grow.log`. |
| `library:youtube` | **Local experiments only.** Well-known songs via yt-dlp: Billboard Year-End Hot 100 for `--years 1960-2024` (lists read from Wikipedia), or `--queries file.txt` / `--playlist URL`. Brings YouTube's "most replayed" heatmap, so these tracks get a real famous-part marker. Keeps its own up-to-date yt-dlp in `library/.venv` (a stale one gets HTTP 403 on audio). Throttled and resumable. |
| `library:import-cache` | Imports songs the old extractor build already downloaded into `.cache/` (English-looking ones; `--all` for everything). |
| `library:build` | Runs the FMA and YouTube downloads together in the background with an ingest pass every 10 minutes. Logs in `library/logs/`. Re-run to resume. |
| `library:freesound` | CC0 risers, impacts, scratches and drum loops. Needs a free `FREESOUND_API_KEY`. |
| `library:kit` | Synthesizes a starter FX/loop kit with ffmpeg - no downloads. |
| `library:ingest` | Decodes and analyzes new files in parallel, writes `meta/`, `covers/`, `catalog.json`. `--reanalyze` recomputes attributes for the whole library after an analysis change. |

**Your own music**: drop files in `library/inbox/` (`inbox/sfx/` and `inbox/loops/` for elements) and run `library:ingest`.

**Licences**: every track keeps its licence and source link (see `/library`). NoDerivatives tracks are skipped by default because a DJ mix is a derivative work; most of the rest are NonCommercial - pass `--commercial` if the app will earn money.

**YouTube tracks are all-rights-reserved.** They carry `source: "youtube"` and exist for local, non-commercial experiments - leave every `yt-*` file out of anything you deploy or share (`rclone sync library … --exclude "yt-*"`, then rebuild the catalog from the remaining metadata).

## Hosting the library on S3 (for the Vercel deployment)

Only the open-licensed set goes up (~70 GB); `yt-*` stays local. The bucket and region live in `.env.local` as `S3_BUCKET` / `S3_REGION`.

```bash
/opt/homebrew/bin/aws login --region ap-southeast-2   # once: signs the CLI in through your browser (no access keys)
npm run library:push -- --dryrun                      # preview
npm run library:push                                  # upload (resumable; re-run to add new tracks). Sets CORS too.
vercel env add LIBRARY_URL production                 # the URL the push prints
```

Live setup: a private bucket (name in `.env.local` as `S3_BUCKET`) behind a CloudFront distribution at `https://d1cnfdphbcrfn4.cloudfront.net`, which is the `LIBRARY_URL` set on Vercel (production). Only that distribution can read the bucket.

Setting up from scratch: the bucket is created private. The app redirects browsers straight to the audio, so before the deployment can play anything the files must be readable: either turn off "Block public access" and add a bucket policy allowing `s3:GetObject` for `Principal: "*"`, or (better) put a CloudFront distribution in front and use its domain as `LIBRARY_URL`.

## Status / findings log

- [ ] Which transition style feels best per genre?
- [ ] Is the computed hook as good as the old replay heatmap? (spot-check against known choruses)
- [ ] Does 30s or 60s feel better before boredom?
- [ ] Lyric transitions: gimmick or magic?
