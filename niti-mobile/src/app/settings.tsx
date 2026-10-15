import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { alert } from "@/components/dialog";
import { router } from "expo-router";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { Bell, CircleAlert, Laptop, LogOut, ScanFace, ShieldAlert, Smartphone, Target, WifiOff, type LucideIcon } from "lucide-react-native";
import { useStore } from "@/lib/store";
import { loadPrefs, savePrefs, type Prefs } from "@/lib/prefs";
import { registerForPush } from "@/lib/push";
import { space, type, useTheme } from "@/lib/theme";
import { Button, Card, Row, SectionLabel, Separator, Switch, Text, Wordmark } from "@/components/ui";
import { Header } from "@/components/header";
import type { PushCategory } from "../../../src/remote/protocol.ts";

const KINDS: [PushCategory, LucideIcon, string, string][] = [
  ["approval", ShieldAlert, "Approvals", "An agent is waiting for your yes or no."],
  ["goal", Target, "Goal finished", "A goal is done, blocked, or out of budget."],
  ["error", CircleAlert, "Errors", "A run failed."],
  ["offline", WifiOff, "Mac offline", "A Mac with a goal running lost its connection."],
];

// Settings as the desktop app groups them: a small capital heading, then a card of rows.
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
    if (err) alert("Notifications", err);
  };

  const toggleLock = async (on: boolean) => {
    if (on && !(await LocalAuthentication.authenticateAsync({ promptMessage: "Require Face ID to open niti" })).success) return;
    setLock(on);
    await AsyncStorage.setItem("niti.lock", on ? "1" : "0");
  };

  const others = snap.devices.filter((d) => d.id !== snap.me?.id);
  const icon = (Icon: LucideIcon) => <Icon color={t.mutedForeground} size={17} />;

  return (
    <View style={{ flex: 1 }}>
      <Header title="Settings" right={<Button variant="ghost" size="sm" title="Done" tone="primary" onPress={() => router.back()} />} />
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(6), paddingBottom: space(10) }}>
        <View>
          <SectionLabel>Notifications</SectionLabel>
          <Card>
            {KINDS.map(([k, Icon, title, body], i) => (
              <View key={k}>
                {i > 0 && <Separator inset={space(4) + 17 + space(3)} />}
                <Row>
                  {icon(Icon)}
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text size={type.base} weight="medium">
                      {title}
                    </Text>
                    <Text size={type.xs} tone="mutedForeground">
                      {body}
                    </Text>
                  </View>
                  <Switch accessibilityLabel={title} value={!!prefs?.push.includes(k)} onValueChange={(v) => void toggle(k, v)} />
                </Row>
              </View>
            ))}
          </Card>
          <View style={{ flexDirection: "row", gap: space(2), paddingHorizontal: space(1), paddingTop: space(2) }}>
            <Bell color={t.mutedForeground} size={12} style={{ marginTop: 3 }} />
            <Text size={type.xs} tone="mutedForeground" style={{ flex: 1 }}>
              Notifications say what happened, never the code or commands. None arrive while the app is open.
            </Text>
          </View>
        </View>

        <View>
          <SectionLabel>Security</SectionLabel>
          <Card>
            <Row>
              {icon(ScanFace)}
              <View style={{ flex: 1, gap: 2 }}>
                <Text size={type.base} weight="medium">
                  Require Face ID to open
                </Text>
                <Text size={type.xs} tone="mutedForeground">
                  Risky approvals always ask for Face ID.
                </Text>
              </View>
              <Switch accessibilityLabel="Require Face ID to open" value={lock} onValueChange={(v) => void toggleLock(v)} />
            </Row>
          </Card>
        </View>

        <View>
          <SectionLabel>{`Devices · ${snap.me?.name ?? "this phone"}`}</SectionLabel>
          <Card>
            {others.length ? (
              others.map((d, i) => (
                <View key={d.id}>
                  {i > 0 && <Separator inset={space(4) + 17 + space(3)} />}
                  <Row>
                    {icon(d.kind === "mac" ? Laptop : Smartphone)}
                    <Text size={type.base} lines={1} style={{ flex: 1 }}>
                      {d.name}
                    </Text>
                    <Text size={type.label} tone="mutedForeground">
                      {d.kind}
                    </Text>
                  </Row>
                </View>
              ))
            ) : (
              <Row>
                <Text size={type.sm} tone="mutedForeground">
                  No other devices on this account.
                </Text>
              </Row>
            )}
          </Card>
        </View>

        <Button
          variant="outline"
          title="Sign out of this phone"
          icon={LogOut}
          tone="destructive"
          onPress={() =>
            alert("Sign out?", "Your Macs stop accepting this phone. Signing in again needs each Mac to allow it again.", [
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

        <View style={{ alignItems: "center", gap: space(2), paddingTop: space(4) }}>
          <Wordmark size={15} align="center" />
          <Text mono size={type.label} tone="mutedForeground">{`mobile ${Constants.expoConfig?.version ?? ""}`}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
