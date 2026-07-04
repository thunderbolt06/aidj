import { Platform } from "react-native";
import { Paths } from "expo-file-system";
import {
  AudioManager,
  PlaybackNotificationManager,
  type AudioEventSubscription,
} from "react-native-audio-api";

/**
 * Registering as a now-playing app (beginReceivingRemoteControlEvents →
 * MRMediaRemoteSetCanBeNowPlayingApplication) SIGSEGVs inside the iOS
 * simulator's MediaRemote stack the moment playback starts. There's no lock
 * screen to integrate with on the simulator anyway, so skip the whole
 * PlaybackNotification surface there. Real devices keep full support.
 */
const IS_IOS_SIMULATOR =
  Platform.OS === "ios" && Paths.document.uri.includes("/CoreSimulator/");

/**
 * OS media integration: audio session (background playback, ignore the mute
 * switch) + lock-screen / notification "Now Playing" card with transport
 * controls. Mirrors the web app's navigator.mediaSession contract:
 *   play/pause → togglePause, next → hopNow, previous → tapInterest
 * (there's no "previous song" in a one-way DJ set - the back button means
 * "keep this one going").
 */

export function setupAudioSession() {
  AudioManager.setAudioSessionOptions({
    iosCategory: "playback",
    iosMode: "default",
    iosOptions: ["allowAirPlay", "allowBluetoothA2DP"],
  });
  AudioManager.setAudioSessionActivity(true).catch(() => {});
  AudioManager.observeAudioInterruptions(true);
}

export interface MediaSessionHandlers {
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

const subs: AudioEventSubscription[] = [];

export function attachMediaControls(handlers: MediaSessionHandlers) {
  if (IS_IOS_SIMULATOR) return;
  detachMediaControls();
  subs.push(
    PlaybackNotificationManager.addEventListener("playbackNotificationPlay", () =>
      handlers.onPlayPause()
    ),
    PlaybackNotificationManager.addEventListener("playbackNotificationPause", () =>
      handlers.onPlayPause()
    ),
    PlaybackNotificationManager.addEventListener(
      "playbackNotificationNextTrack",
      () => handlers.onNext()
    ),
    PlaybackNotificationManager.addEventListener(
      "playbackNotificationPreviousTrack",
      () => handlers.onPrevious()
    )
  );
  PlaybackNotificationManager.enableControl("play", true).catch(() => {});
  PlaybackNotificationManager.enableControl("pause", true).catch(() => {});
  PlaybackNotificationManager.enableControl("nextTrack", true).catch(() => {});
  PlaybackNotificationManager.enableControl("previousTrack", true).catch(() => {});
}

export function detachMediaControls() {
  while (subs.length) subs.pop()?.remove();
}

export function updateNowPlaying(info: {
  title: string;
  artist: string;
  artwork?: string;
  duration?: number;
  elapsedTime?: number;
  playing: boolean;
}) {
  if (IS_IOS_SIMULATOR) return;
  PlaybackNotificationManager.show({
    title: info.title,
    artist: info.artist,
    artwork: info.artwork ? { uri: info.artwork } : undefined,
    duration: info.duration,
    elapsedTime: info.elapsedTime,
    state: info.playing ? "playing" : "paused",
  }).catch(() => {});
}

export function hideNowPlaying() {
  if (IS_IOS_SIMULATOR) return;
  PlaybackNotificationManager.hide().catch(() => {});
}
