import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";
import type { TrackAnalysis } from "../types";
import { getEngine } from "../audio/dj";
import { colors } from "../theme";

/**
 * Compact "clap along" button for the player dock: pulses on every beat of
 * the playing track (rAF off the engine playhead, so it locks to the audio)
 * and flashes on tap. Each tap claims +15s via useAutoMix.tapInterest.
 */
export function BeatTapButton({
  analysis,
  onTap,
  active,
}: {
  analysis: TrackAnalysis | null;
  onTap: () => void;
  active: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const [ringKey, setRingKey] = useState(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      if (analysis && analysis.bpm > 0) {
        const beatLen = 60 / analysis.bpm;
        const anchor = analysis.downbeatOffset ?? analysis.beatOffset;
        const pos = getEngine().position();
        const phase = ((((pos - anchor) % beatLen) + beatLen) % beatLen) / beatLen;
        const punch = Math.pow(1 - phase, 3);
        scale.setValue(1 + punch * 0.12);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, analysis, scale]);

  useEffect(() => {
    if (!ringKey) return;
    ring.setValue(0);
    Animated.timing(ring, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [ringKey, ring]);

  if (!active) return null;

  return (
    <Pressable
      onPress={() => {
        onTap();
        setRingKey(Date.now());
      }}
      hitSlop={6}
    >
      <Animated.View style={[styles.btn, { transform: [{ scale }] }]}>
        <Text style={styles.hand}>+15s</Text>
      </Animated.View>
      {ringKey > 0 && (
        <Animated.View
          key={ringKey}
          pointerEvents="none"
          style={[
            styles.ring,
            {
              opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
              transform: [
                { scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) },
              ],
            },
          ]}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: 44,
    width: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  hand: { fontSize: 11, fontWeight: "700", color: colors.text },
  ring: {
    position: "absolute",
    top: 0,
    left: 0,
    height: 44,
    width: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: "#fff",
  },
});
