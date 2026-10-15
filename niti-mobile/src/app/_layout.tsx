import "react-native-get-random-values"; // first: tweetnacl reads crypto.getRandomValues when it loads
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFonts } from "expo-font";
import { Asset } from "expo-asset";
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold } from "@expo-google-fonts/jetbrains-mono";
import { Lock } from "lucide-react-native";
import { useStore } from "@/lib/store";
import { registerForPush } from "@/lib/push";
import { loadPrefs } from "@/lib/prefs";
import { space, type, useTheme } from "@/lib/theme";
import { Button, Text, Wordmark } from "@/components/ui";
import { AVATAR_IMAGES } from "@/components/avatar";
import { DialogHost } from "@/components/dialog";

export default function RootLayout() {
  const t = useTheme();
  const [fonts] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold });
  const ready = useStore((s) => s.ready);
  // The avatars, downloaded and decoded once at launch, so a list of agents never waits on them.
  const [images, setImages] = useState(false);
  useEffect(() => void Asset.loadAsync(AVATAR_IMAGES).finally(() => setImages(true)), []);
  const link = useStore((s) => s.snap.link);
  const locked = useLock();

  useEffect(() => void useStore.getState().init(), []);

  // Once connected, tell the relay where to push (the token can change between launches).
  useEffect(() => {
    if (link !== "up") return;
    void loadPrefs().then((p) => (p.push.length ? registerForPush(p.push) : undefined));
  }, [link]);

  // A tapped notification opens what it was about.
  useEffect(() => {
    const go = (n: Notifications.Notification) => {
      const route = n.request.content.data?.route;
      // The relay delivers the notification, so its route is only followed when it is a session screen.
      if (typeof route === "string" && /^\/session\/[\w-]+\/[\w-]+(\?sheet=approval)?$/.test(route)) router.push(route as never);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) go(last.notification);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => go(r.notification));
    return () => sub.remove();
  }, []);

  if (!fonts || !ready || !images) return <View style={{ flex: 1, backgroundColor: t.background }} />;
  if (locked) return <LockScreen onUnlock={locked} />;

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.background } }}>
        {/* Both are the app's own page sheets: a partly open sheet is Liquid Glass on iOS 26. */}
        <Stack.Screen name="approval" options={{ presentation: "modal" }} />
        <Stack.Screen name="settings" options={{ presentation: "modal" }} />
      </Stack>
      <DialogHost />
    </>
  );
}

// With "Require Face ID" on, the app locks whenever it goes to the background.
function useLock(): (() => Promise<void>) | undefined {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem("niti.lock").then((v) => setLocked(v === "1"));
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") void AsyncStorage.getItem("niti.lock").then((v) => v === "1" && setLocked(true));
    });
    return () => sub.remove();
  }, []);
  if (!locked) return undefined;
  return async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock niti" });
    if (r.success) setLocked(false);
  };
}

function LockScreen({ onUnlock }: { onUnlock: () => Promise<void> }) {
  const t = useTheme();
  useEffect(() => void onUnlock(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ flex: 1, backgroundColor: t.background, alignItems: "center", justifyContent: "center", gap: space(6), padding: space(6) }}>
      <Wordmark size={type.display} align="center" />
      <Text size={type.sm} tone="mutedForeground">
        Locked. Face ID opens it.
      </Text>
      <Button title="Unlock" icon={Lock} onPress={() => void onUnlock()} style={{ alignSelf: "stretch" }} />
    </View>
  );
}
