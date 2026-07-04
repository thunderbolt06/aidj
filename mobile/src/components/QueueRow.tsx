import React, { useRef } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

/**
 * One row of the queue sheet: swipe left to delete (slides to reveal a trash
 * glyph, animates out past the threshold). Reordering uses the ▲▼ chevrons -
 * the mobile stand-in for the web's drag handle.
 */
export function QueueRow({
  title,
  isNow,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  title: string;
  isNow: boolean;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const dx = useRef(new Animated.Value(0)).current;
  const dxVal = useRef(0);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_e, g) => {
        dxVal.current = Math.min(0, g.dx);
        dx.setValue(dxVal.current);
      },
      onPanResponderRelease: () => {
        if (dxVal.current < -72) {
          Animated.timing(dx, { toValue: -400, duration: 180, useNativeDriver: true }).start(
            onDelete
          );
        } else {
          Animated.timing(dx, { toValue: 0, duration: 150, useNativeDriver: true }).start();
          dxVal.current = 0;
        }
      },
      onPanResponderTerminate: () => {
        Animated.timing(dx, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        dxVal.current = 0;
      },
    })
  ).current;

  return (
    <View style={styles.wrap}>
      <View style={styles.trash}>
        <Text style={{ fontSize: 14, color: "#fff", fontWeight: "700" }}>✕</Text>
      </View>
      <Animated.View
        {...pan.panHandlers}
        style={[
          styles.row,
          isNow ? { backgroundColor: colors.cyanDark } : { backgroundColor: colors.surface },
          { transform: [{ translateX: dx }] },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[styles.title, isNow && { color: colors.cyan }]}
        >
          {title}
        </Text>
        <View style={styles.chevrons}>
          {onMoveUp && (
            <Pressable onPress={onMoveUp} hitSlop={8}>
              <Text style={styles.chevron}>▲</Text>
            </Pressable>
          )}
          {onMoveDown && (
            <Pressable onPress={onMoveDown} hitSlop={8}>
              <Text style={styles.chevron}>▼</Text>
            </Pressable>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative", borderRadius: 6, overflow: "hidden", marginBottom: 4 },
  trash: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: 6,
    backgroundColor: "rgba(220,38,38,0.9)",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingRight: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  title: { flex: 1, color: colors.text, fontSize: 13 },
  chevrons: { flexDirection: "row", gap: 14, paddingLeft: 4 },
  chevron: { color: colors.textGhost, fontSize: 13 },
});
