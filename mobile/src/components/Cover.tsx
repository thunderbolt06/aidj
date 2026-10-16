import React, { useState } from "react";
import { Image, View, type ImageStyle, type StyleProp } from "react-native";

/**
 * Song cover art (square). A cover can 404 or be missing, so a failed load
 * swaps in an empty View with the same style (callers give it a surface
 * background) instead of leaving a blank image box.
 */
export function Cover({ uri, style }: { uri?: string; style: StyleProp<ImageStyle> }) {
  // remember WHICH uri failed so the same slot recovers when the song changes
  const [failedUri, setFailedUri] = useState<string | null>(null);
  if (!uri || failedUri === uri) return <View style={style} />;
  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode="cover"
      onError={() => setFailedUri(uri)}
    />
  );
}
