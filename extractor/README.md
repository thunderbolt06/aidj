# AIDJ Extractor (Railway)

yt-dlp + ffmpeg microservice. Vercel serverless can't run native binaries or
write to disk, so the Next.js app proxies the heavy work here over HTTP.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | , | health check |
| GET | `/search?q=&limit=` | token | YouTube search → `{ tracks }` |
| GET | `/meta/:id` | token | metadata + replay heatmap → `TrackMeta` |
| GET | `/audio/:id` | public (CORS *) | extracted m4a audio (Vercel redirects the browser here) |
| POST | `/video?meta=...` | token | mux a reel WAV + thumbnails → mp4 |

## Deploy on Railway
1. **New Project → Deploy from GitHub repo** → pick this repo.
2. Service **Settings → Root Directory** = `extractor` (so it builds only this folder).
3. Builder is Nixpacks (default); `nixpacks.toml` installs `ffmpeg` + the
   standalone `yt-dlp_linux` binary at `/app/yt-dlp`.
4. **Variables**:
   - `YTDLP_PATH=/app/yt-dlp`
   - `EXTRACTOR_TOKEN=<a long random string>` (use the same value on Vercel)
   - *(later, anti-block)* `YTDLP_PROXY=<residential proxy url>` and/or
     `YTDLP_COOKIES=/data/cookies.txt`
   - *(optional cache persistence)* `CACHE_DIR=/data` + attach a **Volume** at `/data`
5. **Networking → Generate Domain** → copy the public URL (e.g.
   `https://aidj-extractor-production.up.railway.app`).
6. Health-check it: `curl https://<domain>/` → `{"ok":true}`.

## Wire Vercel to it
On the Vercel project, set:
- `EXTRACTOR_URL=https://<your-railway-domain>`
- `EXTRACTOR_TOKEN=<same secret as Railway>`

Redeploy Vercel. When `EXTRACTOR_URL` is set the app calls the extractor; unset
(local dev) it uses a native `yt-dlp` on your PATH.

## Anti-block (Railway IPs get 429'd by YouTube)
Datacenter IPs are throttled/blocked. When extractions start failing:
- set `YTDLP_PROXY` to a residential/rotating proxy, **or**
- export a logged-in `cookies.txt`, put it on the volume, set `YTDLP_COOKIES`.
Both are already wired in `server.js` , no code change needed.
