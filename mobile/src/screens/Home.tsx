import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Track } from "../types";
import { getEngine, loadTrack, searchTracks } from "../audio/dj";
import { useAutoMix } from "../audio/useAutoMix";
import {
  attachMediaControls,
  detachMediaControls,
  hideNowPlaying,
  updateNowPlaying,
} from "../audio/mediaSession";
import { apiUrl } from "../config";
import {
  MIN_PLAY_RANGE,
  MORE_LANGUAGES,
  TOP_LANGUAGES,
  getSelectedLanguageLabels,
  useLanguagePrefs,
  useMinPlaySec,
} from "../prefs";
import { HeatmapBar } from "../components/HeatmapBar";
import { BeatTapButton } from "../components/BeatTapButton";
import { SearchPicker } from "../components/SearchPicker";
import { QueueRow } from "../components/QueueRow";
import { Cover } from "../components/Cover";
import { GearIcon, PauseIcon, PlayIcon, SkipIcon } from "../components/icons";
import { colors } from "../theme";

/**
 * Home = the Compilation deck — RN port of the web app's home page. A
 * streaming-app shell (bottom player dock, queue sheet) around a different
 * listening contract: songs don't play out, the DJ hops when a song has
 * given its best moment, and YOU steer it physically:
 *   - the clap button on the beat = "keep it going" (+15s per tap)
 *   - NEXT: quick tap skips; press & hold builds tension, release drops
 *   - 9-grid = pick the next door instead of a linear queue
 * The seekbar is the replay heatmap: you see WHERE the famous part is, and
 * dragging it scrubs with a vinyl-scratch transition.
 */

interface Suggestion {
  track: Track;
  tag: "safe" | "shift" | "wild";
}

// every situation someone reaches for audio - shuffled a chunk at a time;
// "shuffle" resamples the pool. Mirrors the web app's chip pool.
const VIBE_CHIP_POOL = [
  "singable road trip",
  "study focus session",
  "high session",
  "background for a house party",
  "chill music while we chat",
  "fashion store playlist",
  "jam session with friends",
  "sangeet bangers",
  "2010s pop anthems",
  "late night chill",
  "love time, slow and romantic",
  "movie dialogues mashup",
  "reels time - short viral hooks",
  "meme time - funny songs",
  "bhajan time",
  "gym workout time",
  "sad boi hours",
  "breakup healing",
  "rainy day mood",
  "morning routine energizer",
  "cooking in the kitchen",
  "pre-game hype",
  "long night drive",
  "coffee shop acoustic",
  "yoga and meditation",
  "cleaning the house",
  "shower singing",
  "exam stress relief",
  "airport lounge / traveling",
  "garba and dandiya night",
  "diwali party",
  "holi splash",
  "office lo-fi background",
  "birthday party bangers",
  "late night coding",
  "wedding baraat",
  "anime opening hype",
  "retro 90s bollywood",
  "k-drama feels",
  "poolside chill",
  "afrobeats",
  "techno",
  "EDM festival set",
  "deep house",
  "trance journey",
  "drum and bass",
  "dubstep bass drops",
  "reggae and dancehall",
  "funk and disco",
  "city pop",
  "flamenco",
  "sufi and qawwali",
  "carnatic classical",
  "old school hip hop",
  "trap bangers",
  "synthwave",
  "ambient soundscapes",
  "motivational speeches",
  "true crime podcast",
  "comedy podcast clips",
  "famous game soundtracks",
  "movie score iconic themes",
  "TED talk highlights",
  "standup comedy clips",
  "ASMR and rain sounds",
  "white noise for sleep",
  "nature and forest sounds",
];

const CHIP_DISPLAY_COUNT = 12;

function sampleChips(n: number): string[] {
  const copy = [...VIBE_CHIP_POOL];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const HOLD_MS = 350; // press shorter than this = tap, longer = hold

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Home() {
  const mix = useAutoMix();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState("");
  const [grid, setGrid] = useState<Suggestion[]>([]);
  const [holding, setHolding] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreLangOpen, setMoreLangOpen] = useState(false);
  // mid-set "home": logo tap brings the hero back while the dock keeps playing
  const [homeView, setHomeView] = useState(false);
  // 9-grid tile whose transition is loading (spinner overlay until the hop)
  const [pendingTile, setPendingTile] = useState<string | null>(null);
  const { selected: langSelected, toggle: toggleLang } = useLanguagePrefs();
  const { minPlaySec, setMinPlaySec } = useMinPlaySec();
  const [vibeChips, setVibeChips] = useState(() => sampleChips(CHIP_DISPLAY_COUNT));
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);

  // swipe on the player row: left = next song, right = previous (both hop
  // through a real DJ transition, never a hard cut)
  const playerDx = useRef(new Animated.Value(0)).current;
  const playerDxVal = useRef(0);
  const mixRef = useRef(mix);
  mixRef.current = mix;

  const playerPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        playerDxVal.current = g.dx;
        playerDx.setValue(g.dx);
      },
      onPanResponderRelease: () => {
        const dx = playerDxVal.current;
        playerDxVal.current = 0;
        Animated.timing(playerDx, { toValue: 0, duration: 180, useNativeDriver: true }).start();
        const m = mixRef.current;
        if (dx < -64) {
          m.hopNow(); // swipe left = next song (transition)
        } else if (dx > 64) {
          const prev = m.queue[m.nowIdx - 1];
          if (prev) m.transitionTo(prev); // swipe right = previous song
        }
      },
      onPanResponderTerminate: () => {
        playerDxVal.current = 0;
        Animated.timing(playerDx, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      },
    })
  ).current;

  // OS media controls (lock screen, headphones, car): play/pause → pause
  // toggle, next → skip. No "previous song" in a one-way DJ set — back
  // means "keep this one going" (interest tap), same as the web app.
  useEffect(() => {
    if (!mix.running) return;
    attachMediaControls({
      onPlayPause: () => mixRef.current.togglePause(),
      onNext: () => mixRef.current.hopNow(),
      onPrevious: () => mixRef.current.tapInterest(),
    });
    return () => detachMediaControls();
  }, [mix.running]);

  // keep the OS now-playing card in sync
  useEffect(() => {
    if (!mix.running || !mix.now) {
      hideNowPlaying();
      return;
    }
    updateNowPlaying({
      title: mix.now.meta.title,
      artist: mix.now.meta.artist,
      artwork: mix.now.meta.thumbnail,
      duration: mix.now.analysis.duration,
      elapsedTime: mix.position,
      playing: !mix.paused,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix.running, mix.paused, mix.now]);

  // NEXT button: quick tap = skip now; press & hold = tension builds,
  // release = drop (same contract as the web app's spacebar-hold).
  function nextDown() {
    if (!mix.running) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdingRef.current = true;
      setHolding(true);
      getEngine().tension(true);
    }, HOLD_MS);
  }
  function nextUp() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (holdingRef.current) {
      holdingRef.current = false;
      setHolding(false);
      mix.hopNow(); // release = drop (transition resets the tension FX)
    } else {
      mix.hopNow(); // quick tap = plain skip
    }
  }

  async function refreshGrid(current: Track) {
    try {
      const res = await fetch(apiUrl("/api/ai/suggest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${current.title} - ${current.artist}`,
          languages: getSelectedLanguageLabels(),
        }),
      });
      if (!res.ok) return;
      const { suggestions } = (await res.json()) as {
        suggestions: { query: string; tag: Suggestion["tag"] }[];
      };
      const found = await Promise.all(
        suggestions.map(async (s) => {
          const r = await searchTracks(s.query).catch(() => []);
          return r[0] ? { track: r[0], tag: s.tag } : null;
        })
      );
      // enforce the 5 safe / 3 shift / 1 wild spread even if the model drifts
      const ok = found.filter((s): s is Suggestion => !!s);
      const bucket = (tag: Suggestion["tag"], n: number) =>
        ok.filter((s) => s.tag === tag).slice(0, n);
      const picked = [...bucket("safe", 5), ...bucket("shift", 3), ...bucket("wild", 1)];
      const rest = ok.filter((s) => !picked.includes(s));
      const tiles = [...picked, ...rest].slice(0, 9);
      setGrid(tiles);
      // warm the first tiles so taps are near-instant (stagger extractions);
      // 2, not 3: warmed tracks live in the LRU cache alongside the playing
      // and prepared tracks, and the JS heap can't carry more decoded PCM
      tiles.slice(0, 2).forEach((s, i) => {
        setTimeout(() => loadTrack(s.track.id).catch(() => {}), i * 4000);
      });
    } catch {
      /* suggestions are best-effort */
    }
  }

  async function buildVibe(text: string) {
    if (!text.trim() || busy) return;
    setPrompt(text);
    setBusy("AI is reading the vibe…");
    try {
      const res = await fetch(apiUrl("/api/ai/intent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, languages: getSelectedLanguageLabels() }),
      });
      if (!res.ok) throw new Error("intent failed - is the backend up?");
      const plan = (await res.json()) as { queries: string[] };
      setBusy("finding the songs…");
      const found = await Promise.all(
        plan.queries.map((q) =>
          searchTracks(q)
            .then((r) => r[0] ?? null)
            .catch(() => null)
        )
      );
      const tracks = found.filter((t): t is Track => !!t);
      if (!tracks.length) throw new Error("no songs found - try another vibe");
      setBusy("");
      setHomeView(false);
      if (mix.running) {
        mix.setQueue((q) => [...q, ...tracks]);
        await mix.transitionTo(tracks[0]);
      } else {
        mix.setQueue(tracks);
        await mix.start({
          clipLen: "ai",
          useAi: true,
          quantize: true,
          endless: true,
          minPlaySec,
          onHop: ({ track }) => track && refreshGrid(track),
        });
        mix.prefetch();
        refreshGrid(tracks[0]);
      }
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  async function tapTile(s: Suggestion) {
    if (pendingTile) return; // one transition at a time
    setPendingTile(s.track.id);
    try {
      mix.setQueue((q) => [...q, s.track]);
      await mix.transitionTo(s.track);
      refreshGrid(s.track);
    } finally {
      setPendingTile(null);
    }
  }

  const upNext = mix.queue[(mix.nowIdx + 1) % Math.max(1, mix.queue.length)];
  const duration = mix.now?.analysis.duration ?? 0;
  const showHero = !mix.running || homeView;
  const gridTile = Math.min((screenW - 32 - 12) / 3, 128);

  // ── pieces ────────────────────────────────────────────────────────────────

  const topBar = (
    <View style={[styles.topBar, { top: insets.top + 8 }]}>
      {showHero ? (
        <View style={{ width: 40 }} />
      ) : (
        <Pressable
          onPress={() => {
            setHomeView(true);
            setQueueOpen(false);
          }}
          style={styles.logoBtn}
          hitSlop={4}
        >
          <Text style={styles.logoGlyph}>∞</Text>
        </Pressable>
      )}
      {!showHero && (
        <View style={{ flex: 1, marginHorizontal: 8, zIndex: 60 }}>
          <SearchPicker onPick={(t) => mix.addNext(t)} />
        </View>
      )}
      <Pressable
        onPress={() => setSettingsOpen((o) => !o)}
        style={styles.settingsBtn}
        hitSlop={4}
      >
        <GearIcon />
      </Pressable>
    </View>
  );

  const settingsSheet = settingsOpen && (
    <View style={[styles.settingsPanel, { top: insets.top + 56 }]}>
      <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.settingsHint}>clap = keep it going · hold NEXT = drop</Text>

      <View style={styles.settingsSection}>
        <Text style={styles.settingsLabel}>MIN PLAY TIME · {minPlaySec}s</Text>
        <View style={styles.stepperRow}>
          <Pressable
            onPress={() => {
              const v = Math.max(MIN_PLAY_RANGE.min, minPlaySec - MIN_PLAY_RANGE.step);
              setMinPlaySec(v);
              mix.setOptions({ minPlaySec: v });
            }}
            style={styles.stepBtn}
          >
            <Text style={styles.stepGlyph}>−</Text>
          </Pressable>
          <View style={styles.stepTrack}>
            <View
              style={[
                styles.stepFill,
                {
                  width: `${((minPlaySec - MIN_PLAY_RANGE.min) / (MIN_PLAY_RANGE.max - MIN_PLAY_RANGE.min)) * 100}%`,
                },
              ]}
            />
          </View>
          <Pressable
            onPress={() => {
              const v = Math.min(MIN_PLAY_RANGE.max, minPlaySec + MIN_PLAY_RANGE.step);
              setMinPlaySec(v);
              mix.setOptions({ minPlaySec: v });
            }}
            style={styles.stepBtn}
          >
            <Text style={styles.stepGlyph}>+</Text>
          </Pressable>
        </View>
        <Text style={styles.settingsFoot}>
          every song plays at least {minPlaySec}s before the DJ hops
        </Text>
      </View>

      <View style={styles.settingsSection}>
        <Text style={styles.settingsLabel}>SONG LANGUAGES</Text>
        <View style={styles.chipWrap}>
          {TOP_LANGUAGES.map((l) => (
            <Pressable
              key={l.code}
              onPress={() => toggleLang(l.code)}
              style={[styles.langChip, langSelected.includes(l.code) && styles.langChipOn]}
            >
              <Text
                style={[
                  styles.langChipText,
                  langSelected.includes(l.code) && { color: colors.cyan },
                ]}
              >
                {l.label}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setMoreLangOpen((o) => !o)} style={styles.moreChip}>
            <Text style={styles.langChipText}>{moreLangOpen ? "− less" : "+ more"}</Text>
          </Pressable>
        </View>
        {moreLangOpen && (
          <View style={[styles.chipWrap, { marginTop: 8 }]}>
            {MORE_LANGUAGES.map((l) => (
              <Pressable
                key={l.code}
                onPress={() => toggleLang(l.code)}
                style={[styles.langChip, langSelected.includes(l.code) && styles.langChipOn]}
              >
                <Text
                  style={[
                    styles.langChipText,
                    langSelected.includes(l.code) && { color: colors.cyan },
                  ]}
                >
                  {l.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {langSelected.length === 0 && (
          <Text style={styles.settingsFoot}>none selected - mixes everything</Text>
        )}
      </View>
      </ScrollView>
    </View>
  );

  const hero = (
    <ScrollView
      contentContainerStyle={[styles.heroScroll, { paddingTop: insets.top + 72 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heroInfinity}>∞</Text>
      <Text style={styles.heroTitle}>
        Ever<Text style={{ color: colors.cyan }}>play</Text>
      </Text>
      <Text style={styles.heroTag}>
        Tell it a vibe. It plays only the famous parts, transitions like a DJ,
        and never stops. Clap along to keep a song.
      </Text>
      <View style={styles.promptRow}>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          onSubmitEditing={() => buildVibe(prompt)}
          placeholder="What are we in the mood for?"
          placeholderTextColor={colors.textFaint}
          returnKeyType="go"
          style={styles.promptInput}
        />
        <Pressable
          onPress={() => buildVibe(prompt)}
          disabled={!!busy}
          style={[styles.mixBtn, !!busy && { opacity: 0.5 }]}
        >
          <Text style={styles.mixBtnText}>{busy ? "…" : "Mix it"}</Text>
        </Pressable>
      </View>
      <View style={styles.chipCloud}>
        {vibeChips.map((c) => (
          <Pressable key={c} onPress={() => buildVibe(c)} style={styles.vibeChip}>
            <Text style={styles.vibeChipText}>{c}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => setVibeChips(sampleChips(CHIP_DISPLAY_COUNT))}
        style={styles.shuffleBtn}
      >
        <Text style={styles.shuffleText}>⇄ Shuffle suggestions</Text>
      </Pressable>
      {!!busy && <Text style={styles.busyText}>{busy}</Text>}
    </ScrollView>
  );

  const deck = (
    <View style={[styles.deck, { paddingTop: insets.top + 60 }]}>
      {(busy || mix.status) !== "" && (
        <Text style={styles.busyText}>{busy || mix.status}</Text>
      )}
      <View style={styles.gridWrap}>
        {grid.length > 0 ? (
          <View style={[styles.grid, { width: gridTile * 3 + 12 }]}>
            {grid.map((s, i) => (
              <Pressable
                key={`${s.track.id}-${i}`}
                onPress={() => tapTile(s)}
                style={[
                  styles.tile,
                  { width: gridTile, height: gridTile },
                  pendingTile && pendingTile !== s.track.id && { opacity: 0.4 },
                ]}
              >
                <Cover uri={s.track.thumbnail} style={styles.tileImg} />
                <View style={styles.tileShade} />
                <Text numberOfLines={2} style={styles.tileTitle}>
                  {s.track.title}
                </Text>
                {pendingTile === s.track.id && (
                  <View style={styles.tileSpinner}>
                    <ActivityIndicator color={colors.cyan} />
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={{ color: colors.textGhost, fontSize: 13 }}>
            suggestions load after the first song…
          </Text>
        )}
      </View>
    </View>
  );

  const dock = mix.running && (
    <View style={[styles.dock, { paddingBottom: insets.bottom }]}>
      {/* seek row: the replay heatmap IS the transport */}
      <View style={{ paddingTop: 8, gap: 3 }}>
        {mix.now && (
          <HeatmapBar
            meta={mix.now.meta}
            position={mix.position}
            onSeek={(sec) => mix.seekTo(sec)}
          />
        )}
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{fmt(mix.position)}</Text>
          {mix.interestUntil > mix.position && (
            <Text style={[styles.timeText, { color: colors.emerald }]}>
              claimed to {fmt(mix.interestUntil)}
            </Text>
          )}
          <Text style={styles.timeText}>{fmt(duration)}</Text>
        </View>
      </View>

      {/* player row - swipe left/right to hop to the next/previous song */}
      <Animated.View
        {...playerPan.panHandlers}
        style={[styles.playerRow, { transform: [{ translateX: playerDx }] }]}
      >
        <Pressable
          onPress={() => setHomeView(false)}
          disabled={!homeView}
          style={styles.nowPlaying}
        >
          {mix.now && <Cover uri={mix.now.meta.thumbnail} style={styles.nowThumb} />}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={styles.nowTitle}>
              {mix.now?.meta.title ?? "…"}
            </Text>
            <Text numberOfLines={1} style={styles.nowArtist}>
              {mix.now?.meta.artist}
            </Text>
          </View>
        </Pressable>
        <View style={styles.controls}>
          <BeatTapButton
            analysis={mix.now?.analysis ?? null}
            onTap={() => mix.tapInterest()}
            active={mix.running}
          />
          <Pressable onPress={() => mix.togglePause()} style={styles.ctrlBtn} hitSlop={4}>
            {mix.paused ? <PlayIcon /> : <PauseIcon />}
          </Pressable>
          <View>
            {holding && <Text style={styles.releaseHint}>release to drop</Text>}
            <Pressable
              onPressIn={nextDown}
              onPressOut={nextUp}
              style={[styles.ctrlBtn, holding && styles.ctrlBtnHot, { minWidth: 44 }]}
            >
              {holding ? (
                <Text style={[styles.ctrlGlyph, { color: colors.cyan, fontSize: 11 }]}>DROP</Text>
              ) : (
                <SkipIcon />
              )}
            </Pressable>
          </View>
        </View>
      </Animated.View>

      {/* queue sheet opens ABOVE its bar (which sits at the very bottom) */}
      {queueOpen && (
        <ScrollView style={styles.queueSheet}>
          {mix.queue.map((t, i) => (
            <QueueRow
              key={`${t.id}-${i}`}
              title={t.title}
              thumbnail={t.thumbnail}
              isNow={i === mix.nowIdx}
              onDelete={() => mix.setQueue((q) => q.filter((_, j) => j !== i))}
              onMoveUp={i > 0 ? () => mix.moveInQueue(i, i - 1) : undefined}
              onMoveDown={
                i < mix.queue.length - 1 ? () => mix.moveInQueue(i, i + 1) : undefined
              }
            />
          ))}
        </ScrollView>
      )}

      <Pressable style={styles.queueBar} onPress={() => setQueueOpen((o) => !o)}>
        {upNext && <Cover uri={upNext.thumbnail} style={styles.queueBarThumb} />}
        <Text numberOfLines={1} style={styles.queueBarText}>
          queue: {upNext?.title ?? "…"}
        </Text>
      </Pressable>
    </View>
  );

  // ── layout ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {showHero ? (
        <View style={{ flex: 1 }}>{hero}</View>
      ) : (
        <View style={{ flex: 1 }}>{deck}</View>
      )}
      {dock}
      {topBar}
      {settingsSheet}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  topBar: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 40,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  logoBtn: {
    height: 40,
    width: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  logoGlyph: { color: colors.cyan, fontSize: 22, lineHeight: 26 },
  settingsBtn: {
    height: 40,
    width: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },

  settingsPanel: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDim,
    backgroundColor: "rgba(9,9,11,0.97)",
    padding: 16,
  },
  settingsHint: { fontSize: 11, color: colors.textFaint },
  settingsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderDim,
    gap: 8,
  },
  settingsLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    color: colors.textFaint,
  },
  settingsFoot: { fontSize: 10, color: colors.textGhost },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    height: 32,
    width: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepGlyph: { color: colors.textDim, fontSize: 17, lineHeight: 20 },
  stepTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceHi,
    overflow: "hidden",
  },
  stepFill: { height: 4, backgroundColor: colors.cyanDeep },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  langChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  langChipOn: { borderColor: colors.cyanDeep, backgroundColor: "rgba(8,145,178,0.2)" },
  langChipText: { fontSize: 12, color: colors.textDim },
  moreChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },

  heroScroll: { alignItems: "center", paddingHorizontal: 24, paddingBottom: 140 },
  heroInfinity: {
    fontSize: 56,
    lineHeight: 62,
    color: colors.cyan,
    textShadowColor: "rgba(34,211,238,0.9)",
    textShadowRadius: 24,
  },
  heroTitle: { marginTop: 8, fontSize: 34, fontWeight: "700", color: colors.text },
  heroTag: {
    marginTop: 8,
    maxWidth: 340,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
    color: colors.textDim,
  },
  promptRow: { flexDirection: "row", gap: 8, marginTop: 22, width: "100%" },
  promptInput: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    color: colors.text,
    fontSize: 15,
  },
  mixBtn: {
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.cyanDeep,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.cyan,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  mixBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  chipCloud: {
    marginTop: 22,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  vibeChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.7)",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  vibeChipText: { fontSize: 13, color: colors.textDim },
  shuffleBtn: {
    marginTop: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  shuffleText: { fontSize: 12, color: "#fff" },
  busyText: { marginTop: 12, fontSize: 13, color: colors.amber, textAlign: "center" },

  deck: { flex: 1, paddingHorizontal: 16 },
  gridWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tile: { borderRadius: 12, overflow: "hidden", backgroundColor: colors.surface },
  tileImg: { position: "absolute", width: "100%", height: "100%" },
  tileShade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "55%",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  tileTitle: {
    position: "absolute",
    left: 6,
    right: 6,
    bottom: 5,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 14,
    color: "#fff",
  },
  tileSpinner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },

  dock: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDim,
    backgroundColor: "rgba(9,9,11,0.97)",
    paddingHorizontal: 16,
  },
  timeRow: { flexDirection: "row", justifyContent: "space-between" },
  timeText: { fontSize: 10, color: colors.textFaint, fontVariant: ["tabular-nums"] },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  nowPlaying: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
  nowThumb: { height: 44, width: 44, borderRadius: 10, backgroundColor: colors.surface },
  nowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  nowArtist: { fontSize: 12, color: colors.textFaint, marginTop: 1 },
  controls: { flexDirection: "row", alignItems: "center", gap: 8 },
  ctrlBtn: {
    height: 44,
    minWidth: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  ctrlBtnHot: { borderColor: colors.cyan, shadowColor: colors.cyan, shadowOpacity: 0.7, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  ctrlGlyph: { color: "#fff", fontSize: 16 },
  releaseHint: {
    position: "absolute",
    top: -16,
    alignSelf: "center",
    fontSize: 9,
    color: colors.cyan,
    width: 90,
    textAlign: "center",
  },
  queueSheet: {
    maxHeight: 220,
    borderTopWidth: 1,
    borderTopColor: colors.surface,
    paddingVertical: 10,
  },
  queueBar: {
    borderTopWidth: 1,
    borderTopColor: colors.surface,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  queueBarThumb: { height: 22, width: 22, borderRadius: 4, backgroundColor: colors.surface },
  queueBarText: { fontSize: 12, color: colors.textDim, maxWidth: "90%", flexShrink: 1 },
});
