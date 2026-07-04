import React, { useState } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  Image,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import type { Track } from "../types";
import { searchTracks } from "../audio/dj";
import { colors } from "../theme";

/**
 * Pill-shaped search bar for the deck's top bar — results float over the
 * page on a solid panel and close on pick or ✕.
 */
export function SearchPicker({
  placeholder = "Add a song to the playlist…",
  onPick,
}: {
  placeholder?: string;
  onPick: (t: Track) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResults(await searchTracks(q));
    } catch {
      setError("Search failed - is the backend reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <TextInput
          value={q}
          onChangeText={setQ}
          onSubmitEditing={go}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          returnKeyType="search"
          style={styles.input}
        />
        <Pressable onPress={go} disabled={busy} style={styles.searchBtn} hitSlop={6}>
          {busy ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : (
            <Text style={styles.searchGlyph}>⌕</Text>
          )}
        </Pressable>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      {results.length > 0 && (
        <View style={styles.panel}>
          <Pressable style={styles.close} onPress={() => setResults([])} hitSlop={8}>
            <Text style={{ color: colors.textFaint, fontSize: 15 }}>✕</Text>
          </Pressable>
          <FlatList
            data={results}
            keyExtractor={(t) => t.id}
            keyboardShouldPersistTaps="handled"
            style={{ maxHeight: 290 }}
            renderItem={({ item: t }) => (
              <Pressable
                onPress={() => {
                  onPick(t);
                  setResults([]);
                  setQ("");
                }}
                style={({ pressed }) => [styles.result, pressed && { backgroundColor: colors.surface }]}
              >
                <Image source={{ uri: t.thumbnail }} style={styles.thumb} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={styles.title}>
                    {t.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.subtitle}>
                    {t.artist} · {Math.floor(t.duration / 60)}:
                    {String(t.duration % 60).padStart(2, "0")}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "relative", flex: 1 },
  row: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.9)",
    paddingHorizontal: 16,
    fontSize: 14,
    color: colors.text,
  },
  searchBtn: {
    height: 40,
    width: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(24,24,27,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  searchGlyph: { color: colors.textDim, fontSize: 20, lineHeight: 22 },
  error: { marginTop: 6, fontSize: 12, color: "#f87171" },
  panel: {
    position: "absolute",
    top: 48,
    left: 0,
    right: 0,
    zIndex: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDim,
    backgroundColor: "rgba(9,9,11,0.98)",
    paddingTop: 26,
    overflow: "hidden",
  },
  close: { position: "absolute", top: 6, right: 10, zIndex: 2 },
  result: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDim,
  },
  thumb: { height: 40, width: 64, borderRadius: 4, backgroundColor: colors.surface },
  title: { color: colors.text, fontSize: 13 },
  subtitle: { color: colors.textDim, fontSize: 11, marginTop: 1 },
});
