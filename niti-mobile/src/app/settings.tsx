import { useEffect, useState } from "react";
import { Alert, ScrollView, Switch, View } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { useStore } from "@/lib/store";
import { loadPrefs, savePrefs, type Prefs } from "@/lib/prefs";
import { registerForPush } from "@/lib/push";
import { space, useTheme } from "@/lib/theme";
import { Button, Card, Text } from "@/components/ui";
import type { PushCategory } from "../../../src/remote/protocol.ts";

const KINDS: [PushCategory, string, string][] = [
  ["approval", "Approvals", "An agent is waiting for your yes or no."],
  ["goal", "Goal finished", "A goal is done, blocked, or out of budget."],
  ["error", "Errors", "A run failed."],
  ["offline", "Mac offline", "A Mac with a goal running lost its connection."],
];

export default function Settings() {
  const t = useTheme();
  const snap = useStore((s) => s.snap);
  const [prefs, setPrefs] = useState<Prefs>();
  const [lock, setLock] = useState(false);

  useEffect(() => {
    void loadPrefs().then(setPrefs);
    void AsyncStorage.getItem("niti.lock").then((v) => setLock(v === "1"));
  }, []);

  const toggle = async (k: PushCategory, on: boolean) => {
    if (!prefs) return;
    const next = { push: on ? [...prefs.push, k] : prefs.push.filter((x) => x !== k) };
    setPrefs(next);
    await savePrefs(next);
    const err = await registerForPush(next.push);
    if (err) Alert.alert("Notifications", err);
  };

  const toggleLock = async (on: boolean) => {
    if (on && !(await LocalAuthentication.authenticateAsync({ promptMessage: "Require Face ID to open niti" })).success) return;
    setLock(on);
    await AsyncStorage.setItem("niti.lock", on ? "1" : "0");
  };

  const others = snap.devices.filter((d) => d.id !== snap.me?.id);

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(6) }}>
      <View style={{ gap: space(2) }}>
        <Text size={14} tone="muted" weight="600">
          Notifications
        </Text>
        <Card>
          {KINDS.map(([k, title, body]) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(1) }}>
              <View style={{ flex: 1 }}>
                <Text>{title}</Text>
                <Text size={13} tone="muted">
                  {body}
                </Text>
              </View>
              <Switch accessibilityLabel={title} value={!!prefs?.push.includes(k)} onValueChange={(v) => void toggle(k, v)} trackColor={{ true: t.primary }} />
            </View>
          ))}
        </Card>
        <Text size={13} tone="muted">
          Notifications say what happened, never the code or commands. You won't get them while the app is open.
        </Text>
      </View>

      <View style={{ gap: space(2) }}>
        <Text size={14} tone="muted" weight="600">
          Security
        </Text>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(3) }}>
            <View style={{ flex: 1 }}>
              <Text>Require Face ID to open</Text>
              <Text size={13} tone="muted">
                Risky approvals always ask for Face ID.
              </Text>
            </View>
            <Switch accessibilityLabel="Require Face ID to open" value={lock} onValueChange={(v) => void toggleLock(v)} trackColor={{ true: t.primary }} />
          </View>
        </Card>
      </View>

      <View style={{ gap: space(2) }}>
        <Text size={14} tone="muted" weight="600">
          {snap.me ? `Signed in on ${snap.me.name}` : "Account"}
        </Text>
        <Card>
          {others.map((d) => (
            <Text key={d.id}>{`${d.kind === "mac" ? "Mac" : "Phone"}: ${d.name}`}</Text>
          ))}
          {!others.length && <Text tone="muted">No other devices.</Text>}
        </Card>
        <Button
          kind="destructive"
          title="Sign out of this phone"
          onPress={() =>
            Alert.alert("Sign out?", "Your Macs stop accepting this phone. Signing in again needs each Mac to allow it again.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Sign out",
                style: "destructive",
                onPress: async () => {
                  await useStore.getState().signOut();
                  router.replace("/sign-in");
                },
              },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}
