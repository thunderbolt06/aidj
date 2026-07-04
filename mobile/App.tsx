import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Home from "./src/screens/Home";
import { initConfig } from "./src/config";
import { initPrefs } from "./src/prefs";
import { setupAudioSession } from "./src/audio/mediaSession";
import { colors } from "./src/theme";

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      await Promise.all([initConfig(), initPrefs()]);
      setupAudioSession();
      setReady(true);
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {ready ? <Home /> : <View style={{ flex: 1, backgroundColor: colors.bg }} />}
    </SafeAreaProvider>
  );
}
