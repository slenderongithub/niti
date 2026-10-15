import "react-native-get-random-values"; // first: tweetnacl reads crypto.getRandomValues when it loads
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFonts, JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import { useStore } from "@/lib/store";
import { registerForPush } from "@/lib/push";
import { loadPrefs } from "@/lib/prefs";
import { useTheme } from "@/lib/theme";
import { Button, Text } from "@/components/ui";

export default function RootLayout() {
  const t = useTheme();
  const [fonts] = useFonts({ JetBrainsMono_400Regular });
  const ready = useStore((s) => s.ready);
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

  if (!fonts || !ready) return <View style={{ flex: 1, backgroundColor: t.background }} />;
  if (locked) return <LockScreen onUnlock={locked} />;

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.background },
          headerTintColor: t.primary,
          headerTitleStyle: { color: t.foreground },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: "Sign in", headerLargeTitle: true }} />
        <Stack.Screen name="macs" options={{ title: "Your Macs", headerLargeTitle: true, headerBackVisible: false }} />
        <Stack.Screen name="session/[mac]/[session]" options={{ title: "" }} />
        <Stack.Screen name="approval" options={{ presentation: "formSheet", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, headerShown: false }} />
        <Stack.Screen name="settings" options={{ presentation: "modal", title: "Settings" }} />
      </Stack>
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
    <View style={{ flex: 1, backgroundColor: t.background, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
      <Text size={20} weight="600">
        niti is locked
      </Text>
      <Button title="Unlock" onPress={() => void onUnlock()} />
    </View>
  );
}
