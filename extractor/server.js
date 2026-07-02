/**
 * AIDJ extractor microservice.
 *
 * Vercel serverless can't run yt-dlp/ffmpeg or write to disk, so the heavy
 * native work lives here (Railway). The Next.js app proxies to this over HTTP
 * via EXTRACTOR_URL. Endpoints mirror the app's server functions:
 *
 *   GET  /                health check
 *   GET  /search?q=&limit=    → { tracks: [...] }            (token-protected)
 *   GET  /meta/:id            → TrackMeta                     (token-protected)
 *   GET  /audio/:id           → audio/mp4 bytes (CORS *, public; browser-facing)
 *   POST /video?meta=...      → video/mp4 (body: WAV)         (token-protected)
 *
 * Anti-block hooks (set later when Railway's datacenter IP gets 429'd):
 *   YTDLP_PROXY    → yt-dlp --proxy <url>     (residential/rotating proxy)
 *   YTDLP_COOKIES  → yt-dlp --cookies <path>  (exported YouTube cookies.txt)
 */
const http = require("node:http");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdir, readdir, readFile, writeFile, stat } = require("node:fs/promises");
const { createReadStream, existsSync } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const exec = promisify(execFile);

const PORT = process.env.PORT || 8080;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

// yt-dlp's JS challenge solver looks for a JS runtime (deno) on PATH, but the
// Nixpacks runtime PATH doesn't include /usr/local/bin where the build puts it.
// Prepending here propagates to every spawned child (yt-dlp, ffmpeg, bgutil).
if (!(process.env.PATH || "").includes("/usr/local/bin")) {
  process.env.PATH = `/usr/local/bin:${process.env.PATH || ""}`;
}
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const TOKEN = process.env.EXTRACTOR_TOKEN || ""; // optional shared secret
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, ".cache");
const AUDIO_DIR = path.join(CACHE_DIR, "audio");
const META_DIR = path.join(CACHE_DIR, "meta");

// extra yt-dlp args for anti-block , inert until the env vars are set
function antiBlockArgs() {
  const args = [];
  // Force IPv4: hosts with a broken/blackholed IPv6 route to Google make yt-dlp
  // stall ~per-request retrying IPv6 before falling back, stacking into 80–160s
  // hangs that blow past our timeouts. Set YTDLP_IPV6=1 to opt back into IPv6.
  if (process.env.YTDLP_IPV6 !== "1") args.push("-4");
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);
  return args;
}

async function ensureDirs() {
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(META_DIR, { recursive: true });
}

// ── yt-dlp logic (mirrors lib/server/ytdlp.ts) ──────────────────────────────

async function searchYouTube(query, limit = 8) {
  const { stdout } = await exec(
    YTDLP,
    [
      `ytsearch${limit}:${query}`,
      "--dump-json",
      "--flat-playlist",
      "--no-warnings",
      ...antiBlockArgs(),
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const j = JSON.parse(line);
      return {
        id: j.id,
        title: j.title ?? "Unknown",
        artist: j.channel ?? j.uploader ?? "Unknown",
        duration: Math.round(j.duration ?? 0),
        thumbnail:
          j.thumbnails?.at(-1)?.url ??
          `https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`,
      };
    })
    .filter((t) => t.duration > 30 && t.duration < 720);
}

function famousStartFromHeatmap(heatmap) {
  const candidates = heatmap.filter((p) => p.start > 10);
  if (!candidates.length) return null;
  const peak = candidates.reduce((a, b) => (b.value > a.value ? b : a));
  return Math.round(peak.start);
}

async function getTrackMeta(id) {
  await ensureDirs();
  const metaPath = path.join(META_DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    /* not cached */
  }
  const { stdout } = await exec(
    YTDLP,
    [
      `https://www.youtube.com/watch?v=${id}`,
      "--dump-json",
      "--no-warnings",
      ...antiBlockArgs(),
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
  );
  const j = JSON.parse(stdout);
  const heatmap = (j.heatmap ?? []).map((p) => ({
    start: p.start_time,
    end: p.end_time,
    value: p.value,
  }));
  const meta = {
    id,
    title: j.title ?? "Unknown",
    artist: j.artist ?? j.channel ?? j.uploader ?? "Unknown",
    duration: Math.round(j.duration ?? 0),
    thumbnail: j.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    heatmap,
    famousStart: famousStartFromHeatmap(heatmap),
  };
  await writeFile(metaPath, JSON.stringify(meta));
  return meta;
}

const inflightAudio = new Map(); // id → Promise<filepath>, dedupes concurrent pulls

async function getAudioFile(id) {
  await ensureDirs();
  const existing = (await readdir(AUDIO_DIR)).find((f) => f.startsWith(`${id}.`));
  if (existing) return path.join(AUDIO_DIR, existing);
  if (inflightAudio.has(id)) return inflightAudio.get(id);

  const job = (async () => {
    await exec(
      YTDLP,
      [
        `https://www.youtube.com/watch?v=${id}`,
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "-x",
        "--audio-format",
        "m4a",
        "-o",
        path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
        "--no-warnings",
        ...antiBlockArgs(),
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }
    );
    const file = (await readdir(AUDIO_DIR)).find((f) => f.startsWith(`${id}.`));
    if (!file) throw new Error(`extraction produced no file for ${id}`);
    return path.join(AUDIO_DIR, file);
  })();
  inflightAudio.set(id, job);
  try {
    return await job;
  } finally {
    inflightAudio.delete(id);
  }
}

const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
].filter(Boolean);

function captionFilter(caption) {
  if (!caption) return "";
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font) return "";
  const safe = caption.replace(/[^\p{L}\p{N} '!?-]/gu, "").slice(0, 40);
  if (!safe) return "";
  return (
    `drawtext=fontfile='${font}':text='${safe}':` +
    `fontcolor=white:fontsize=110:borderw=7:bordercolor=black@0.85:` +
    `x=(w-text_w)/2:y=h*0.74`
  );
}

async function renderVideo(wav, meta, res) {
  const dir = await mkdtemp(path.join(tmpdir(), "aidj-reel-"));
  try {
    const wavPath = path.join(dir, "mix.wav");
    await writeFile(wavPath, wav);
    const imgPaths = [];
    for (let i = 0; i < meta.clips.length; i++) {
      const r = await fetch(meta.clips[i].image);
      if (!r.ok) throw new Error(`thumbnail ${i} failed`);
      const p = path.join(dir, `img${i}.jpg`);
      await writeFile(p, Buffer.from(await r.arrayBuffer()));
      imgPaths.push(p);
    }
    const args = ["-y"];
    meta.clips.forEach((c, i) => {
      args.push("-loop", "1", "-t", String(Math.max(c.duration, 1)), "-i", imgPaths[i]);
    });
    args.push("-i", wavPath);
    const filters = meta.clips
      .map(
        (_, i) =>
          `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
          `crop=1080:1920,setsar=1,fps=30[v${i}]`
      )
      .join(";");
    const cap = captionFilter(meta.caption);
    const concat =
      meta.clips.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${meta.clips.length}:v=1:a=0` +
      (cap ? `[vbase];[vbase]${cap}[vout]` : `[vout]`);
    const out = path.join(dir, "reel.mp4");
    args.push(
      "-filter_complex", `${filters};${concat}`,
      "-map", "[vout]", "-map", `${meta.clips.length}:a`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-shortest", out
    );
    await exec(FFMPEG, args, { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    const mp4 = await readFile(out);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="aidj-reel.mp4"',
    });
    res.end(mp4);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === "/" || p === "/health") return json(res, 200, { ok: true });

    // search
    if (p === "/search" && req.method === "GET") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const q = url.searchParams.get("q");
      if (!q) return json(res, 400, { error: "missing q" });
      const limit = Number(url.searchParams.get("limit")) || 8;
      const tracks = await searchYouTube(q, limit);
      return json(res, 200, { tracks });
    }

    // meta
    const metaMatch = p.match(/^\/meta\/([\w-]{6,})$/);
    if (metaMatch && req.method === "GET") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, await getTrackMeta(metaMatch[1]));
    }

    // audio , browser-facing: CORS open, served via redirect from Vercel
    const audioMatch = p.match(/^\/audio\/([\w-]{6,})$/);
    if (audioMatch && req.method === "GET") {
      const file = await getAudioFile(audioMatch[1]);
      const ext = file.split(".").pop() || "m4a";
      const mime = { m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm", opus: "audio/ogg", mp3: "audio/mpeg" }[ext] || "audio/mp4";
      const { size } = await stat(file);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": String(size),
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      return createReadStream(file).pipe(res);
    }

    // clip , a 16kHz mono mp3 window for Whisper word alignment
    if (p === "/clip" && req.method === "GET") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const id = url.searchParams.get("id");
      const start = Math.max(0, Number(url.searchParams.get("start")) || 0);
      const dur = Math.min(60, Number(url.searchParams.get("dur")) || 20);
      if (!id) return json(res, 400, { error: "missing id" });
      const file = await getAudioFile(id);
      const dir = await mkdtemp(path.join(tmpdir(), "aidj-clip-"));
      const out = path.join(dir, "clip.mp3");
      try {
        await exec(
          FFMPEG,
          ["-y", "-ss", String(start), "-t", String(dur), "-i", file,
           "-ac", "1", "-ar", "16000", "-b:a", "48k", out],
          { timeout: 30_000 }
        );
        const buf = await readFile(out);
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        return res.end(buf);
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // video (ffmpeg mux)
    if (p === "/video" && req.method === "POST") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const metaRaw = url.searchParams.get("meta");
      if (!metaRaw) return json(res, 400, { error: "missing meta" });
      const meta = JSON.parse(metaRaw);
      const wav = await readBody(req);
      if (!wav.length) return json(res, 400, { error: "missing audio" });
      return await renderVideo(wav, meta, res);
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e instanceof Error ? e.message : "error" });
  }
});

// bgutil-ytdlp-pot-provider server , mints PO tokens so yt-dlp's bundled
// bgutil plugin (installed to /app/yt-dlp-plugins) can get real formats for
// cookie-authenticated requests. Optional: only spawned if the nixpacks
// build vendored it (see nixpacks.toml) and only useful when YTDLP_COOKIES
// is set. Restarts on crash rather than taking the whole extractor down.
const BGUTIL_SERVER_ENTRY =
  process.env.BGUTIL_SERVER_PATH || "/app/bgutil-server/server/build/main.js";
function startBgutilServer() {
  if (!existsSync(BGUTIL_SERVER_ENTRY)) return;
  const child = spawn("node", [BGUTIL_SERVER_ENTRY], { stdio: "inherit" });
  child.on("exit", (code) => {
    console.error(`bgutil-provider exited (${code}), restarting in 5s`);
    setTimeout(startBgutilServer, 5000);
  });
}
startBgutilServer();

server.listen(PORT, () => console.log(`aidj-extractor listening on :${PORT}`));
