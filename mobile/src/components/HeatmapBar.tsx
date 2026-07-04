import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, type LayoutChangeEvent } from "react-native";
import type { TrackMeta } from "../types";
import { colors } from "../theme";

/**
 * Replay-heatmap strip with famous-part marker and live playhead — the
 * transport bar. With `onSeek`, touch anywhere to jump, or drag: a ghost
 * playhead follows the finger and the seek fires on release.
 */
export function HeatmapBar({
  meta,
  position,
  onSeek,
}: {
  meta: TrackMeta;
  position?: number;
  onSeek?: (sec: number) => void;
}) {
  const d = meta.duration || 1;
  const [width, setWidth] = useState(0);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const widthRef = useRef(0);
  const barRef = useRef<View>(null);
  const originX = useRef(0);

  // fraction from the touch's pageX — locationX is relative to whichever
  // CHILD view sits under the finger (a heatmap segment), not the bar
  const frac = (pageX: number) =>
    widthRef.current > 0
      ? Math.min(1, Math.max(0, (pageX - originX.current) / widthRef.current))
      : 0;

  return (
    <View
      ref={barRef}
      style={styles.bar}
      onLayout={(e: LayoutChangeEvent) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
        barRef.current?.measureInWindow((x) => {
          originX.current = x;
        });
      }}
      onStartShouldSetResponder={() => !!onSeek}
      onMoveShouldSetResponder={() => !!onSeek}
      onResponderGrant={(e) => setDragFrac(frac(e.nativeEvent.pageX))}
      onResponderMove={(e) => setDragFrac(frac(e.nativeEvent.pageX))}
      onResponderRelease={(e) => {
        setDragFrac(null);
        onSeek?.(frac(e.nativeEvent.pageX) * d);
      }}
      onResponderTerminate={() => setDragFrac(null)}
    >
      {width > 0 &&
        meta.heatmap.map((p, i) => (
          <View
            key={i}
            style={{
              position: "absolute",
              bottom: 0,
              left: (p.start / d) * width,
              width: Math.max(2, ((p.end - p.start) / d) * width),
              height: Math.max(3, p.value * 40),
              backgroundColor: "rgba(14,116,144,0.7)", // cyan-700/70
            }}
          />
        ))}
      {width > 0 && meta.famousStart !== null && (
        <View
          style={[styles.marker, { left: (meta.famousStart / d) * width, backgroundColor: colors.amber }]}
        />
      )}
      {width > 0 && position !== undefined && (
        <View
          style={[styles.marker, { left: (Math.min(position, d) / d) * width, backgroundColor: "#fff" }]}
        />
      )}
      {width > 0 && dragFrac !== null && (
        <View style={[styles.marker, { left: dragFrac * width, backgroundColor: colors.cyan }]}>
          <Text style={styles.ghostTime}>
            {Math.floor((dragFrac * d) / 60)}:
            {String(Math.floor((dragFrac * d) % 60)).padStart(2, "0")}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 40,
    width: "100%",
    borderRadius: 4,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  marker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
  },
  ghostTime: {
    position: "absolute",
    top: 0,
    left: 6,
    fontSize: 9,
    color: colors.cyan,
    backgroundColor: "rgba(9,9,11,0.9)",
    paddingHorizontal: 3,
    borderRadius: 3,
    fontVariant: ["tabular-nums"],
  },
});
