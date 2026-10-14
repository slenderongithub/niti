import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Stack, router } from "expo-router";
import { ChevronRight, Laptop, Settings } from "lucide-react-native";
import { useStore, remoteClient } from "@/lib/store";
import { space, useTheme } from "@/lib/theme";
import { Card, Chip, Empty, Text } from "@/components/ui";
import type { SessionInfo } from "../../../src/remote/protocol.ts";

// What a Mac leaves on the relay (bridge.ts sendStatus), readable once that Mac has welcomed this phone.
interface MacStatus {
  project: string;
  running: boolean;
  approvals: number;
  goal: { objective: string; state: string; reason: string; round: number; maxRounds: number } | null;
  at: number;
}

export default function Macs() {
  const t = useTheme();
  const snap = useStore((s) => s.snap);
  const macs = useMemo(() => snap.devices.filter((d) => d.kind === "mac"), [snap.devices]);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={12} onPress={() => router.push("/settings")}>
              <Settings color={t.primary} size={22} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space(4), gap: space(6) }}>
        {snap.link !== "up" && (
          <Text tone={snap.error ? "destructive" : "muted"} size={14}>
            {snap.error ?? (snap.link === "connecting" ? "Connecting to the relay…" : "Offline")}
          </Text>
        )}
        {snap.link === "up" && !macs.length && <Empty title="No Mac yet" body="On your Mac, run /remote login with the same email. It shows up here as soon as it signs in." />}
        {macs.map((mac) => (
          <MacGroup key={mac.id} id={mac.id} name={mac.name} sessions={snap.sessions.filter((s) => s.mac === mac.id)} />
        ))}
      </ScrollView>
    </>
  );
}

function MacGroup({ id, name, sessions }: { id: string; name: string; sessions: SessionInfo[] }) {
  const t = useTheme();
  const allowed = sessions.some((s) => s.allowed);
  const denied = sessions.some((s) => s.denied);
  const online = sessions.some((s) => s.online);
  const code = remoteClient()?.codeFor(id);

  return (
    <View style={{ gap: space(2) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <Laptop color={t.muted} size={18} accessibilityElementsHidden />
        <Text size={14} tone="muted" weight="600">
          {name}
        </Text>
      </View>
      {!sessions.length ? (
        <Card>
          <Text tone="muted">No niti running on this Mac. Start niti in a project there and it appears here.</Text>
        </Card>
      ) : denied && !allowed ? (
        <Card>
          <Text weight="600">Denied on the Mac</Text>
          <Text tone="muted">Restart niti there to be asked again.</Text>
        </Card>
      ) : !allowed ? (
        <Card>
          <Text weight="600">Waiting for your Mac</Text>
          <Text tone="muted">{online ? `niti on ${name} is asking whether to allow this phone. Allow it there only if it shows this code:` : `Open niti on ${name}. It will ask whether to allow this phone, showing this code:`}</Text>
          <Text mono size={34} weight="600" style={{ letterSpacing: 8, marginTop: space(2) }}>
            {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "······"}
          </Text>
        </Card>
      ) : (
        sessions.filter((s) => s.allowed).map((s) => <SessionRow key={s.session} s={s} />)
      )}
    </View>
  );
}

function SessionRow({ s }: { s: SessionInfo }) {
  const t = useTheme();
  const status = remoteClient()?.statusOf<MacStatus>(s);
  const g = status?.goal;
  const project = status?.project ?? "Project";
  const ago = s.online ? undefined : sinceText(s.lastSeen);
  return (
    <Card onPress={() => router.push(`/session/${s.mac}/${s.session}`)} label={`${project}, ${s.online ? "online" : `offline ${ago}`}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <View style={{ flex: 1, gap: space(1) }}>
          <Text size={17} weight="600" lines={1}>
            {project}
          </Text>
          {g ? (
            <Text tone="muted" size={14} lines={2}>
              {g.state === "running" ? `Goal, round ${g.round} of ${g.maxRounds}: ${g.objective}` : `Goal ${g.state}: ${g.objective}`}
            </Text>
          ) : (
            <Text tone="muted" size={14}>
              {status?.running ? "Working" : s.online ? "Idle" : "Offline"}
            </Text>
          )}
        </View>
        <ChevronRight color={t.muted} size={20} />
      </View>
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        <Chip text={s.online ? "Online" : `Offline ${ago}`} tone={s.online ? "success" : "muted"} />
        {!!status?.approvals && <Chip text={`${status.approvals} waiting for you`} tone="warning" />}
      </View>
    </Card>
  );
}

function sinceText(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
