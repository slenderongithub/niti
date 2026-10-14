import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowUp, CircleStop, Ellipsis, Hand, ShieldAlert } from "lucide-react-native";
import { groupItems, steerTarget, type AgentView, type RenderItem } from "../../../../../niti-app/src/renderer/src/lib/reducer";
import { statusColor, TASK_GLYPH } from "../../../../../niti-app/src/renderer/src/lib/identity";
import { goalLive } from "../../../../../niti-app/src/renderer/src/lib/types";
import { useStore } from "@/lib/store";
import { mono, radius, resolveColor, space, useTheme } from "@/lib/theme";
import { Button, Card, Chip, Code, Empty, Text } from "@/components/ui";

type Tab = "agents" | "tasks" | "changes";

export default function SessionScreen() {
  const { mac, session, sheet } = useLocalSearchParams<{ mac: string; session: string; sheet?: string }>();
  const t = useTheme();
  const open = useStore((s) => s.open);
  const opening = useStore((s) => s.opening);
  const error = useStore((s) => s.error);
  const state = useStore((s) => s.state);
  const [tab, setTab] = useState<Tab>("agents");

  useEffect(() => {
    void useStore.getState().openSession(mac, session);
    return () => useStore.getState().closeSession();
  }, [mac, session]);

  // Opened from an approval push: show it as soon as it has arrived.
  useEffect(() => {
    if (sheet === "approval" && open && state.approvals.length) router.push("/approval");
  }, [sheet, open, state.approvals.length]);

  if (!open) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space(6), gap: space(4) }}>
        {opening || !error ? <ActivityIndicator color={t.primary} /> : <Empty title="Couldn't reach the Mac" body={error} action={<Button title="Try again" onPress={() => void useStore.getState().openSession(mac, session)} />} />}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={90} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: open.project, headerRight: () => <SessionMenu /> }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(6) }}>
        <GoalCard />
        <RunLine />
        {state.approvals.length > 0 && (
          <Card onPress={() => router.push("/approval")} label={`${state.approvals.length} approvals waiting`} style={{ borderColor: t.warning }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
              <ShieldAlert color={t.warning} size={20} />
              <Text weight="600">{state.approvals.length === 1 ? "1 request is waiting for you" : `${state.approvals.length} requests are waiting for you`}</Text>
            </View>
          </Card>
        )}
        <Tabs tab={tab} setTab={setTab} />
        {tab === "agents" ? <Agents /> : tab === "tasks" ? <Tasks /> : <Changes />}
      </ScrollView>
      <Composer />
    </KeyboardAvoidingView>
  );
}

function GoalCard() {
  const t = useTheme();
  const g = useStore((s) => s.state.goalStatus);
  const [busy, setBusy] = useState(false);
  if (!g) return null;
  const run = async (args: string) => {
    setBusy(true);
    try {
      const r = await useStore.getState().command("goal", args);
      if (!r.ok) Alert.alert("Goal", r.message);
    } catch (err) {
      Alert.alert("Goal", err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };
  const last = g.verdicts.at(-1);
  const spent = [`${Math.round(g.used.tokens / 1000)}k tokens`, g.used.cost ? `$${g.used.cost.toFixed(2)}` : ""].filter(Boolean).join(", ");
  return (
    <Card style={{ borderColor: g.state === "running" ? t.primary : t.border }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space(2) }}>
        <Chip text={g.state === "running" ? `Goal, round ${g.round} of ${g.maxRounds}` : `Goal ${g.state}`} tone={g.state === "running" ? "primary" : g.state === "done" ? "success" : "warning"} />
        <Text size={13} tone="muted">
          {spent}
        </Text>
      </View>
      <Text size={17} weight="600">
        {g.objective}
      </Text>
      {!!g.reason && <Text tone="muted">{g.reason}</Text>}
      {last && g.state === "running" && !!last.next && <Text size={14} tone="muted">{`Next: ${last.next}`}</Text>}
      {!!g.notes.length && <Text size={14} tone="muted">{`Your notes for the next round: ${g.notes.join("; ")}`}</Text>}
      <View style={{ flexDirection: "row", gap: space(2), marginTop: space(1) }}>
        {g.state === "running" && <Button kind="secondary" title="Pause after round" onPress={() => void run("pause")} busy={busy} style={{ flex: 1 }} />}
        {g.state === "paused" && <Button title="Resume" onPress={() => void run("resume")} busy={busy} style={{ flex: 1 }} />}
        {(g.state === "budget" || g.state === "rounds") && <Button title="5 more rounds" onPress={() => void run("more --rounds 5").then(() => run("resume"))} busy={busy} style={{ flex: 1 }} />}
        {goalLive(g) && (
          <Button
            kind="secondary"
            title="Stop"
            onPress={() => Alert.alert("Stop the goal?", "The round in progress is cancelled.", [{ text: "Keep going", style: "cancel" }, { text: "Stop", style: "destructive", onPress: () => void run("stop") }])}
          />
        )}
      </View>
    </Card>
  );
}

function RunLine() {
  const t = useTheme();
  const active = useStore((s) => s.state.active);
  const status = useStore((s) => s.state.status);
  const awake = useStore((s) => s.state.awake);
  const cost = useStore((s) => s.state.cost);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), flexWrap: "wrap" }}>
      {active && <ActivityIndicator size="small" color={t.primary} />}
      <Text tone="muted" size={14} lines={1} style={{ flexShrink: 1 }}>
        {active ? status || "Working" : status || "Idle"}
      </Text>
      {awake !== "off" && <Chip text={awake === "lid" ? "Mac kept awake" : "Awake, lid open"} tone="warning" />}
      {cost > 0 && <Chip text={`$${cost.toFixed(2)} this session`} />}
    </View>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const t = useTheme();
  const items: [Tab, string][] = [
    ["agents", "Agents"],
    ["tasks", "Tasks"],
    ["changes", "Changes"],
  ];
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: t.raised, borderRadius: radius, padding: 3 }}>
      {items.map(([k, label]) => (
        <Pressable
          key={k}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === k }}
          onPress={() => setTab(k)}
          style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius - 3, backgroundColor: tab === k ? t.card : "transparent" }}
        >
          <Text size={15} weight={tab === k ? "600" : "400"} tone={tab === k ? "default" : "muted"}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Agents() {
  const order = useStore((s) => s.state.order);
  const agents = useStore((s) => s.state.agents);
  const [openId, setOpenId] = useState<string>();
  if (!order.length) return <Empty title="No team" body="This project has no agents yet. Set it up on the Mac." />;
  return (
    <View style={{ gap: space(3) }}>
      {order.map((id) => (
        <AgentCard key={id} a={agents[id]!} open={openId === id} toggle={() => setOpenId(openId === id ? undefined : id)} />
      ))}
    </View>
  );
}

function AgentCard({ a, open, toggle }: { a: AgentView; open: boolean; toggle: () => void }) {
  const t = useTheme();
  const color = resolveColor(t, a.color);
  const items = useMemo(() => groupItems(a.items).slice(open ? -40 : -1), [a.items, open]);
  const working = a.status === "working";
  const interrupt = () =>
    Alert.prompt(
      `Interrupt ${a.cfg.role}`,
      "It stops what it's doing and carries on from your message. Leave it empty to just make it stop and reconsider.",
      async (text) => {
        try {
          await useStore.getState().call("POST", `/agents/${encodeURIComponent(a.id)}/interrupt`, { text: text ?? "" });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (err) {
          Alert.alert("Couldn't interrupt", err instanceof Error ? err.message : String(err));
        }
      },
      "plain-text",
    );
  return (
    <Card onPress={toggle} label={`${a.cfg.role}, ${a.status}${a.activity ? `, ${a.activity}` : ""}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
        <Text weight="600" style={{ flex: 1 }} lines={1}>
          {a.cfg.role}
        </Text>
        <Text size={13} tone="muted" style={{ color: resolveColor(t, statusColor(a.status)) }}>
          {a.status}
        </Text>
      </View>
      {!!a.activity && (
        <Text size={14} tone="muted" lines={open ? undefined : 1}>
          {a.activity}
        </Text>
      )}
      {items.map((it) => (
        <ItemRow key={it.id} it={it} compact={!open} />
      ))}
      {open && working && <Button kind="secondary" title="Interrupt" icon={<Hand color={t.foreground} size={18} />} onPress={interrupt} />}
    </Card>
  );
}

function ItemRow({ it, compact }: { it: RenderItem; compact: boolean }) {
  switch (it.kind) {
    case "text":
      return <Text lines={compact ? 2 : undefined}>{it.text}</Text>;
    case "tool":
      return (
        <Text size={14} tone={it.status === "fail" ? "destructive" : "muted"} lines={1}>
          {`${it.verb} ${it.target}`.trim()}
        </Text>
      );
    case "group":
      return (
        <Text size={14} tone="muted" lines={1}>
          {`${it.verb} ${it.items.length} files`}
        </Text>
      );
    case "shell":
      return compact ? (
        <Text mono size={13} tone={it.ok ? "muted" : "destructive"} lines={1}>
          {`$ ${it.command}`}
        </Text>
      ) : (
        <Code tone={it.ok ? "default" : "destructive"} lines={12}>
          {[`$ ${it.command}`, ...it.body.slice(-10)].join("\n")}
        </Code>
      );
    case "diff":
      return (
        <Text size={14} tone="muted" lines={1}>
          {`${it.created ? "Created" : "Edited"} ${it.path}  +${it.added} -${it.removed}`}
        </Text>
      );
    case "note":
      return (
        <Text size={14} tone={it.tone === "error" ? "destructive" : it.tone === "warning" ? "warning" : "muted"} lines={compact ? 1 : undefined}>
          {it.text}
        </Text>
      );
    case "plan-done":
      return (
        <Text size={14} tone="muted">
          {`Plan finished, ${it.steps} steps`}
        </Text>
      );
  }
}

function Tasks() {
  const t = useTheme();
  const tasks = useStore((s) => s.state.tasks);
  const agents = useStore((s) => s.state.agents);
  if (!tasks.length) return <Empty title="No tasks" body="The board fills in when the team plans a run." />;
  return (
    <Card>
      {tasks.map((task) => (
        <View key={task.id} style={{ flexDirection: "row", gap: space(3), paddingVertical: space(1.5) }}>
          <Text mono style={{ color: resolveColor(t, statusColor(task.status)) }}>
            {TASK_GLYPH[task.status]}
          </Text>
          <View style={{ flex: 1 }}>
            <Text>{task.description}</Text>
            <Text size={13} tone="muted">
              {`${task.status.replace("_", " ")}${task.assignedTo ? `, ${agents[task.assignedTo]?.cfg.role ?? task.assignedTo}` : ""}`}
            </Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

interface Worktree {
  active?: boolean;
  branch?: string;
  diffStat?: string;
}

function Changes() {
  const summary = useStore((s) => s.state.summary);
  const touched = useStore((s) => s.state.touched);
  const running = useStore((s) => s.state.active || goalLive(s.state.goalStatus));
  const [wt, setWt] = useState<Worktree>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useStore.getState().call<Worktree>("GET", "/worktree").then(setWt).catch(() => {});
  }, [running]);
  const edited = Object.entries(touched).filter(([, k]) => k !== "R");
  const act = (what: "merge" | "discard") =>
    Alert.alert(what === "merge" ? "Merge into your project?" : "Throw these changes away?", what === "merge" ? `Brings ${wt?.branch} into the project on your Mac.` : "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: what === "merge" ? "Merge" : "Discard",
        style: what === "merge" ? "default" : "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const r = await useStore.getState().call<{ ok: boolean; message: string }>("POST", `/worktree/${what}`);
            Alert.alert(r.ok ? "Done" : "Couldn't do that", r.message);
            setWt(await useStore.getState().call<Worktree>("GET", "/worktree"));
          } catch (err) {
            Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        },
      },
    ]);
  return (
    <View style={{ gap: space(3) }}>
      {wt?.active && (
        <Card>
          <Text weight="600">{`Waiting in ${wt.branch}`}</Text>
          {!!wt.diffStat && <Code lines={10}>{wt.diffStat}</Code>}
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Button title="Merge" onPress={() => act("merge")} busy={busy} disabled={running} style={{ flex: 1 }} />
            <Button kind="secondary" title="Discard" onPress={() => act("discard")} disabled={running || busy} />
          </View>
          {running && <Text size={13} tone="muted">Merging waits until the run or goal stops.</Text>}
        </Card>
      )}
      {summary && (
        <Card>
          <Text weight="600">Last run</Text>
          {!!summary.summary && <Text tone="muted">{summary.summary}</Text>}
          {summary.files.map((f) => (
            <Text key={f.path} mono size={13}>
              {`${f.path}  +${f.added} -${f.removed}`}
            </Text>
          ))}
        </Card>
      )}
      {edited.length ? (
        <Card>
          <Text weight="600">Changed this session</Text>
          {edited.map(([path, k]) => (
            <Text key={path} mono size={13} tone="muted">
              {`${k === "A" ? "+" : "~"} ${path}`}
            </Text>
          ))}
        </Card>
      ) : (
        !summary && <Empty title="No changes yet" body="Files the team writes show up here." />
      )}
    </View>
  );
}

function SessionMenu() {
  const t = useTheme();
  const active = useStore((s) => s.state.active);
  const awake = useStore((s) => s.state.awake);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      const r = (await fn()) as { message?: string } | undefined;
      if (r?.message) Alert.alert("niti", r.message);
    } catch (err) {
      Alert.alert("niti", err instanceof Error ? err.message : String(err));
    }
  };
  const s = useStore.getState();
  const open = () =>
    Alert.alert("This project", undefined, [
      ...(active ? [{ text: "Stop the run", style: "destructive" as const, onPress: () => void run(() => s.call("POST", "/cancel")) }] : []),
      awake === "off" ? { text: "Keep the Mac awake", onPress: () => void run(() => s.command("awake")) } : { text: "Let the Mac sleep", onPress: () => void run(() => s.command("awake", "off")) },
      { text: "Status", onPress: () => void run(() => s.command("status")) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Project actions" hitSlop={12} onPress={open}>
      {active ? <CircleStop color={t.primary} size={22} /> : <Ellipsis color={t.primary} size={22} />}
    </Pressable>
  );
}

function Composer() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const state = useStore((s) => s.state);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const live = goalLive(state.goalStatus);
  const placeholder = live ? "A note for the goal" : state.active ? "Message the team" : "What should the team do?  (/goal for a long run)";
  const suggestions = !state.active && !live ? (state.summary?.next ?? []).slice(0, 3) : [];

  const send = async (raw: string) => {
    const msg = raw.trim();
    if (!msg) return;
    setBusy(true);
    const s = useStore.getState();
    try {
      if (msg.startsWith("/")) {
        const [name = "", ...rest] = msg.slice(1).split(" ");
        const r = await s.command(name, rest.join(" "));
        if (r.message) Alert.alert(`/${name}`, r.message);
      } else if (live) {
        await s.command("goal", `note ${msg}`);
      } else if (state.active) {
        const to = steerTarget(state);
        if (!to) throw new Error("nobody is working right now");
        await s.call("POST", `/agents/${encodeURIComponent(to)}/message`, { text: msg });
      } else {
        await s.call("POST", "/prompt", { text: msg, mode: "build" });
      }
      setText("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert("Not sent", err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <View style={{ borderTopWidth: 1, borderColor: t.border, backgroundColor: t.background, paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: Math.max(insets.bottom, space(2)), gap: space(2) }}>
      {!!suggestions.length && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
          {suggestions.map((sg) => (
            <Pressable key={sg} accessibilityRole="button" accessibilityLabel={`Use suggestion: ${sg}`} onPress={() => setText(sg)} style={{ borderWidth: 1, borderColor: t.border, borderRadius: 999, paddingHorizontal: space(3), minHeight: 44, justifyContent: "center", maxWidth: 280 }}>
              <Text size={14} lines={1}>
                {sg}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space(2) }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={t.muted}
          accessibilityLabel={placeholder}
          multiline
          style={{ flex: 1, minHeight: 44, maxHeight: 140, borderRadius: radius, borderWidth: 1, borderColor: t.border, backgroundColor: t.card, color: t.foreground, paddingHorizontal: space(3), paddingTop: 11, paddingBottom: 11, fontSize: 16, fontFamily: text.startsWith("/") ? mono : undefined }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={busy || !text.trim()}
          onPress={() => void send(text)}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: t.primary, alignItems: "center", justifyContent: "center", opacity: busy || !text.trim() ? 0.4 : pressed ? 0.8 : 1 })}
        >
          {busy ? <ActivityIndicator color={t.primaryForeground} /> : <ArrowUp color={t.primaryForeground} size={22} />}
        </Pressable>
      </View>
    </View>
  );
}
