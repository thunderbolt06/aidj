import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Backend base URL. All app traffic goes through the Next.js API routes
 * (search/meta/audio proxy + AI planning) so API keys stay server-side and
 * the extractor server stays unchanged.
 *
 * Dev defaults: the Mac's dev server. The iOS simulator shares the host's
 * loopback; the Android emulator reaches the host at 10.0.2.2.
 * A stored override (settings) wins — that's also how the TestFlight build
 * points at the deployed backend.
 */
const DEV_DEFAULT = Platform.select({
  android: "http://10.0.2.2:3000",
  default: "http://127.0.0.1:3000",
});

/** Deployed backend for release builds — set before shipping to TestFlight. */
const PROD_DEFAULT = "https://aidj.vercel.app";

const STORAGE_KEY = "everplay:apiBase";

let apiBase = __DEV__ ? DEV_DEFAULT! : PROD_DEFAULT;

/** Load the stored override; call once at app start before any fetches. */
export async function initConfig(): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) apiBase = stored;
  } catch {
    /* defaults stand */
  }
}

export function getApiBase(): string {
  return apiBase;
}

export async function setApiBase(url: string): Promise<void> {
  apiBase = url.replace(/\/$/, "");
  await AsyncStorage.setItem(STORAGE_KEY, apiBase);
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}
