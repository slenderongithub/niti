import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { ChevronRight, Folder, Laptop, Link2, Settings, ShieldAlert, Target, WifiOff } from "lucide-react-native";
import { useStore, remoteClient } from "@/lib/store";
import { alpha, radius, space, TOUCH, type, useTheme } from "@/lib/theme";
import { Badge, Button, Card, CardContent, Dot, EmptyState, Separator, Spinner, Text, Wordmark } from "@/components/ui";
import { Header } from "@/components/header";
import type { SessionInfo } from "../../../src/remote/protocol.ts";

// What a Mac leaves on the relay (bridge.ts sendStatus), readable once that Mac has welcomed this phone.
interface MacStatus {
  project: string;
  running: boolean;
  approvals: number;
  goal: { objective: string; state: string; reason: string; round: number; maxRounds: number } | null;
  at: number;
}

// Your Macs and the projects running on each, like the desktop app's "Recent projects" card.
export default function Macs() {
  const t = useTheme();
  const snap = useStore((s) => s.snap);
  // Only the Macs this phone paired with: anyone can register a device under an email.
  const macs = useMemo(() => snap.devices.filter((d) => d.kind === "mac" && remoteClient()?.id?.macs[d.id]), [snap.devices]);

  return (
    <View style={{ flex: 1 }}>
      <Header left={<Wordmark size={17} />} right={<Button variant="outline" size="sm" icon={Settings} title="Settings" onPress={() => router.push("/settings")} />} />
      <ScrollView contentContainerStyle={{ padding: space(4), paddingTop: space(6), gap: space(5) }}>
        <View style={{ gap: space(1), paddingHorizontal: space(1) }}>
          <Text size={type.xl} weight="semibold" accessibilityRole="header">
            Projects
          </Text>
          <Text size={type.sm} tone="mutedForeground">
            niti running on your Macs. Tap one to watch and steer it.
          </Text>
        </View>
        {snap.link !== "up" && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(1) }}>
            {snap.link === "connecting" ? <Spinner size={type.xs} /> : <WifiOff color={snap.error ? t.destructive : t.mutedForeground} size={13} />}
            <Text size={type.xs} tone={snap.error ? "destructive" : "mutedForeground"} style={{ flex: 1 }}>
              {snap.error ?? (snap.link === "connecting" ? "connecting to the relay…" : "offline")}
            </Text>
          </View>
        )}
        {snap.link === "up" && !macs.length && (
          <EmptyState icon={Laptop} title="No Mac yet" description="On your Mac, run /remote on with your email, then pair with the code it shows." />
        )}
        {macs.map((mac) => (
          <MacCard key={mac.id} name={mac.name} sessions={snap.sessions.filter((s) => s.mac === mac.id && s.allowed)} />
        ))}
        <Button variant="outline" icon={Link2} title="Pair another Mac" onPress={() => router.push("/sign-in")} />
      </ScrollView>
    </View>
  );
}

function MacCard({ name, sessions }: { name: string; sessions: SessionInfo[] }) {
  const t = useTheme();
  const online = sessions.some((s) => s.online);

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), minHeight: 52, borderBottomWidth: 1, borderColor: t.border }}>
        <Laptop color={t.mutedForeground} size={16} />
        <Text size={type.sm} weight="semibold" lines={1} style={{ flex: 1 }}>
          {name}
        </Text>
        <Dot color={online ? t.success : alpha(t.mutedForeground, 0.4)} />
        <Text size={type.label} tone="mutedForeground">
          {online ? "online" : "offline"}
        </Text>
      </View>

      {!sessions.length ? (
        <CardContent>
          <Text size={type.sm} tone="mutedForeground">
            No niti running on this Mac. Start niti in a project there and it appears here.
          </Text>
        </CardContent>
      ) : (
        sessions.map((s, i) => (
          <View key={s.session}>
            {i > 0 && <Separator inset={space(4) + 36 + space(3)} />}
            <SessionRow s={s} />
          </View>
        ))
      )}
    </Card>
  );
}

function SessionRow({ s }: { s: SessionInfo }) {
  const t = useTheme();
  const status = remoteClient()?.statusOf<MacStatus>(s);
  const g = status?.goal;
  const project = status?.project ?? "project";
  const ago = s.online ? undefined : sinceText(s.lastSeen);
  const line = g
    ? g.state === "running"
      ? `goal ${g.round}/${g.maxRounds} · ${g.objective}`
      : `goal ${g.state} · ${g.objective}`
    : status?.running
      ? "working"
      : s.online
        ? "idle"
        : `last seen ${ago}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${project}, ${s.online ? "online" : `offline, last seen ${ago}`}, ${line}`}
      onPress={() => router.push(`/session/${s.mac}/${s.session}`)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space(3),
        paddingHorizontal: space(4),
        paddingVertical: space(3),
        minHeight: TOUCH + 12,
        backgroundColor: pressed ? t.accent : "transparent",
      })}
    >
      <View style={{ width: 36, height: 36, borderRadius: radius.lg, backgroundColor: g?.state === "running" ? alpha(t.primary, 0.12) : t.muted, alignItems: "center", justifyContent: "center" }}>
        {g ? <Target color={g.state === "running" ? t.primary : t.mutedForeground} size={16} /> : <Folder color={t.mutedForeground} size={16} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={type.base} weight="medium" lines={1}>
          {project}
        </Text>
        <Text mono size={type.label} tone={g?.state === "running" ? "primary" : "mutedForeground"} lines={1}>
          {line}
        </Text>
      </View>
      {!!status?.approvals && <Badge text={String(status.approvals)} tone="warning" icon={ShieldAlert} />}
      {!s.online && (
        <Text size={type.label} tone="mutedForeground">
          {ago}
        </Text>
      )}
      <ChevronRight color={t.mutedForeground} size={16} />
    </Pressable>
  );
}

function sinceText(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
