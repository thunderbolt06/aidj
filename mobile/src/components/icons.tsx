import React from "react";
import { View, StyleSheet } from "react-native";

/**
 * View-drawn player icons. Emoji-presentation glyphs (⏸ ⏭ ⚙ 👏) render as
 * tofu boxes in this RN/iOS combination, so the controls draw their own
 * shapes — also guarantees pixel-identical rendering on Android.
 */

export function PauseIcon({ color = "#fff", size = 16 }: { color?: string; size?: number }) {
  const bar = { width: size * 0.28, height: size, backgroundColor: color, borderRadius: 1.5 };
  return (
    <View style={[styles.row, { gap: size * 0.22 }]}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

export function PlayIcon({ color = "#fff", size = 16 }: { color?: string; size?: number }) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        marginLeft: size * 0.15,
        borderTopWidth: size * 0.55,
        borderBottomWidth: size * 0.55,
        borderLeftWidth: size * 0.9,
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
        borderLeftColor: color,
      }}
    />
  );
}

export function SkipIcon({ color = "#fff", size = 14 }: { color?: string; size?: number }) {
  const tri = {
    width: 0,
    height: 0,
    borderTopWidth: size * 0.5,
    borderBottomWidth: size * 0.5,
    borderLeftWidth: size * 0.75,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: color,
  } as const;
  return (
    <View style={[styles.row, { gap: 1 }]}>
      <View style={tri} />
      <View style={tri} />
      <View style={{ width: size * 0.2, height: size, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

export function GearIcon({ color = "#a1a1aa", size = 16 }: { color?: string; size?: number }) {
  // three stacked lines — reads as "settings/menu" without glyph support
  const line = { width: size, height: 2, backgroundColor: color, borderRadius: 1 };
  return (
    <View style={{ gap: size * 0.25 }}>
      <View style={line} />
      <View style={line} />
      <View style={line} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
});
