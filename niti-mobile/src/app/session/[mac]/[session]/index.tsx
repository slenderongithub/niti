import { memo, useEffect, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { alert } from "@/components/dialog";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";
import * as Haptics from "expo-haptics";
import {
  ArrowRight,
  ArrowUp,
  Coffee,
  Coins,
  Ellipsis,
  FileDiff,
  GitBranch,
  GitMerge,
  Gauge,
  ListTodo,
  Pause,
  Play,
  Plus,
  ShieldAlert,
  Square,
  Target,
  Trash2,
  Unplug,
  Users,
  WifiOff,
} from "lucide-react-native";
import { steerTarget, type AgentView } from "../../../../../../niti-app/src/renderer/src/lib/reducer";
import { statusColor, TASK_GLYPH } from "../../../../../../niti-app/src/renderer/src/lib/identity";
import { goalLive } from "../../../../../../niti-app/src/renderer/src/lib/types";
import { fmtCost, fmtTokens } from "../../../../../../niti-app/src/renderer/src/lib/format";
import { useStore } from "@/lib/store";
import { alpha, fonts, radius, resolveColor, space, TOUCH, type, useTheme } from "@/lib/theme";
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, CodeBlock, Dot, EmptyState, Progress, SectionLabel, Separator, Spinner, Tabs, Text } from "@/components/ui";
import { AgentAvatar, PixelAvatar } from "@/components/avatar";
import { Header } from "@/components/header";

type Tab = "team" | "tasks" | "changes";

export default function SessionScreen() {
  const { mac, session, sheet } = useLocalSearchParams<{ mac: string; session: string; sheet?: string }>();
  const open = useStore((s) => s.open);
  const opening = useStore((s) => s.opening);
  const error = useStore((s) => s.error);
  const approvals = useStore((s) => s.state.approvals.length);
  const counts = useStore(
    useShallow((s) => ({
      agents: s.state.order.length,
      done: s.state.tasks.filter((x) => x.status === "done").length,
      tasks: s.state.tasks.length,
      changed: Object.values(s.state.touched).filter((k) => k !== "R").length,
    })),
  );
  const [tab, setTab] = useState<Tab>("team");

  useEffect(() => {
    void useStore.getState().openSession(mac, session);
    return () => useStore.getState().closeSession();
  }, [mac, session]);

  // Opened from an approval push: show it as soon as it has arrived.
  useEffect(() => {
    if (sheet === "approval" && open && approvals) router.push("/approval");
  }, [sheet, open, approvals]);

  if (!open) {
    return (
      <View style={{ flex: 1 }}>
        <Header back="Projects" />
        <View style={{ flex: 1, justifyContent: "center" }}>
          {opening || !error ? (
            <View style={{ alignItems: "center", gap: space(3) }}>
              <Spinner size={type.xl} />
              <Text size={type.xs} tone="mutedForeground">
                opening an encrypted session…
              </Text>
            </View>
          ) : (
            <EmptyState
              icon={Unplug}
              title="Couldn't reach the Mac"
              description={error}
              action={<Button title="Try again" variant="outline" onPress={() => void useStore.getState().openSession(mac, session)} />}
            />
          )}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Header back="Projects" title={open.project} right={<SessionMenu />} />
      <ScrollView keyboardDismissMode="interactive" contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(6) }}>
        <StatusStrip />
        {approvals > 0 && <ApprovalsBanner n={approvals} />}
        <GoalCard />
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            ["team", "Team", counts.agents],
            ["tasks", "Tasks", counts.tasks ? `${counts.done}/${counts.tasks}` : undefined],
            ["changes", "Changes", counts.changed || undefined],
          ]}
        />
        {tab === "team" ? <Team mac={mac} session={session} /> : tab === "tasks" ? <Tasks /> : <Changes />}
      </ScrollView>
      <Composer />
    </KeyboardAvoidingView>
  );
}

// The desktop app's status bar, as a strip under the title: the link, the goal, keep-awake, the
// deepest context, and the session's tokens and cost. Lowercase, small, muted, like there.
function StatusStrip() {
  const t = useTheme();
  const s = useStore((x) => x.state);
  const deepest = s.order
    .map((id) => s.agents[id]!)
    .filter((a) => a.ctxLimit)
    .map((a) => ({ role: a.cfg.role, pct: Math.min(100, Math.round((a.usage.lastInput * 100) / a.ctxLimit)) }))
    .sort((a, b) => b.pct - a.pct)[0];
  const g = s.goalStatus;
  const total = s.totals.inputTokens + s.totals.outputTokens;
  const item = (children: React.ReactNode, key: string) => (
    <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {children}
    </View>
  );
  return (
    <View accessibilityRole="summary" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space(3), rowGap: space(1.5), paddingHorizontal: space(1) }}>
      {s.connection === "lost"
        ? item(
            <>
              <WifiOff color={t.destructive} size={12} />
              <Text size={type.label} tone="destructive">
                reconnecting…
              </Text>
            </>,
            "link",
          )
        : item(
            <>
              <Dot color={t.success} />
              <Text size={type.label} tone="mutedForeground">
                {s.active ? "working" : "connected"}
              </Text>
            </>,
            "link",
          )}
      {g &&
        item(
          <>
            <Target color={g.state === "running" ? t.primary : t.mutedForeground} size={12} />
            <Text size={type.label} tone={g.state === "running" ? "primary" : "mutedForeground"}>
              {g.state === "running" ? `goal ${g.round}/${g.maxRounds}` : `goal ${g.state}`}
            </Text>
          </>,
          "goal",
        )}
      {s.awake !== "off" &&
        item(
          <>
            <Coffee color={t.warning} size={12} />
            <Text size={type.label} tone="warning">
              {s.awake === "lid" ? "awake" : "awake · lid open"}
            </Text>
          </>,
          "awake",
        )}
      {deepest &&
        deepest.pct > 0 &&
        item(
          <>
            <Gauge color={deepest.pct >= 80 ? t.destructive : deepest.pct >= 60 ? t.warning : t.mutedForeground} size={12} />
            <Text size={type.label} tone={deepest.pct >= 80 ? "destructive" : deepest.pct >= 60 ? "warning" : "mutedForeground"}>{`ctx ${deepest.pct}%`}</Text>
          </>,
          "ctx",
        )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginLeft: "auto" }}>
        <Coins color={t.mutedForeground} size={12} />
        <Text mono size={type.label} tone="mutedForeground">{`${fmtTokens(total)} tok · ${fmtCost(s.cost, s.costKnown)}`}</Text>
      </View>
    </View>
  );
}

function ApprovalsBanner({ n }: { n: number }) {
  const t = useTheme();
  return (
    <Card onPress={() => router.push("/approval")} label={`${n} waiting for you. Review.`} accent={alpha(t.warning, 0.45)} style={{ backgroundColor: alpha(t.warning, 0.08) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), minHeight: TOUCH + 8 }}>
        <ShieldAlert color={t.warning} size={18} />
        <Text size={type.sm} weight="medium" style={{ flex: 1 }}>
          {n === 1 ? "A request is waiting for you" : `${n} requests are waiting for you`}
        </Text>
        <Text size={type.sm} weight="medium" tone="warning">
          Review
        </Text>
        <ArrowRight color={t.warning} size={15} />
      </View>
    </Card>
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
      if (!r.ok) alert("Goal", r.message);
    } catch (err) {
      alert("Goal", err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };
  const running = g.state === "running";
  const last = g.verdicts.at(-1);
  const tone = running ? "primary" : g.state === "done" ? "success" : g.state === "paused" ? "mutedForeground" : "warning";
  return (
    <Card accent={running ? alpha(t.primary, 0.4) : undefined}>
      <CardHeader
        icon={
          <View style={{ width: 32, height: 32, borderRadius: radius.lg, backgroundColor: alpha(t[tone], 0.12), alignItems: "center", justifyContent: "center" }}>
            <Target color={t[tone]} size={16} />
          </View>
        }
        title={
          <Text size={type.base} weight="semibold" selectable>
            {g.objective}
          </Text>
        }
        description={
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), flexWrap: "wrap" }}>
            <Badge text={running ? `round ${g.round}/${g.maxRounds}` : g.state} tone={tone} />
            <Text mono size={type.label} tone="mutedForeground">{`${fmtTokens(g.used.tokens)} tok${g.used.cost ? ` · $${g.used.cost.toFixed(2)}` : ""}`}</Text>
          </View>
        }
      />
      <CardContent style={{ gap: space(2.5) }}>
        <Progress value={(g.round / Math.max(1, g.maxRounds)) * 100} color={t[tone]} />
        {!!g.reason && (
          <Text size={type.sm} tone="mutedForeground">
            {g.reason}
          </Text>
        )}
        {running && !!last?.next && (
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Text mono size={type.sm} tone="primary">
              ▸
            </Text>
            <Text size={type.sm} style={{ flex: 1 }}>
              {last.next}
            </Text>
          </View>
        )}
        {!!g.notes.length && (
          <Text size={type.xs} tone="mutedForeground">
            {`Your notes for the next round: ${g.notes.join("; ")}`}
          </Text>
        )}
      </CardContent>
      <CardFooter>
        {running && <Button variant="outline" size="sm" title="Pause after round" icon={Pause} onPress={() => void run("pause")} busy={busy} style={{ flex: 1 }} />}
        {g.state === "paused" && <Button size="sm" title="Resume" icon={Play} onPress={() => void run("resume")} busy={busy} style={{ flex: 1 }} />}
        {(g.state === "budget" || g.state === "rounds") && (
          <Button size="sm" title="5 more rounds" icon={Plus} onPress={() => void run("more --rounds 5").then(() => run("resume"))} busy={busy} style={{ flex: 1 }} />
        )}
        {goalLive(g) && (
          <Button
            variant="outline"
            size="sm"
            title="Stop"
            icon={Square}
            tone="destructive"
            onPress={() =>
              alert("Stop the goal?", "The round in progress is cancelled.", [
                { text: "Keep going", style: "cancel" },
                { text: "Stop", style: "destructive", onPress: () => void run("stop") },
              ])
            }
          />
        )}
      </CardFooter>
    </Card>
  );
}

// The team, row for row as the desktop's agents rail draws it.
function Team({ mac, session }: { mac: string; session: string }) {
  const order = useStore((s) => s.state.order);
  const agents = useStore((s) => s.state.agents);
  const lead = useStore((s) => s.state.leadId);
  if (!order.length) return <EmptyState icon={Users} title="No team" description="This project has no agents yet. Set it up on the Mac." />;
  return (
    <View>
      <SectionLabel>{`Team · ${order.length}`}</SectionLabel>
      <Card>
        {order.map((id, i) => (
          <View key={id}>
            {i > 0 && <Separator inset={space(4)} />}
            <AgentRow a={agents[id]!} lead={id === lead} onPress={() => router.push(`/session/${mac}/${session}/agent/${encodeURIComponent(id)}`)} />
          </View>
        ))}
      </Card>
    </View>
  );
}

const AgentRow = memo(function AgentRow({ a, lead, onPress }: { a: AgentView; lead: boolean; onPress: () => void }) {
  const t = useTheme();
  const color = resolveColor(t, a.color);
  const ctx = a.ctxLimit ? Math.min(100, Math.round((a.usage.lastInput * 100) / a.ctxLimit)) : 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${a.cfg.role}${lead ? ", lead" : ""}, ${a.status}${a.activity ? `, ${a.activity}` : ""}. Open transcript.`}
      onPress={onPress}
      style={({ pressed }) => ({ paddingHorizontal: space(4), paddingVertical: space(3), gap: space(2.5), backgroundColor: pressed ? t.accent : "transparent" })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3) }}>
        <AgentAvatar slot={a.index} lead={lead} status={a.status} size={32} />
        <View style={{ flex: 1 }}>
          <Text size={type.base} weight="semibold" lines={1}>
            {a.cfg.role}
          </Text>
          <Text mono size={type.label} tone="mutedForeground" lines={1}>
            {a.cfg.model}
          </Text>
        </View>
        <Text size={type.label} style={{ color: resolveColor(t, statusColor(a.status)) }}>
          {a.status}
        </Text>
      </View>
      {a.status === "working" && !!a.activity && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Spinner size={type.label} />
          <Text size={type.xs} tone="mutedForeground" lines={1} style={{ flex: 1 }}>
            {a.activity}
          </Text>
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <Progress value={ctx} color={ctx >= 80 ? t.destructive : ctx >= 60 ? t.warning : color} />
        <Text mono size={type.label} tone="mutedForeground" style={{ width: 52, textAlign: "right" }}>
          {fmtTokens(a.usage.inputTokens + a.usage.outputTokens)}
        </Text>
      </View>
    </Pressable>
  );
});

function Tasks() {
  const t = useTheme();
  const tasks = useStore((s) => s.state.tasks);
  const agents = useStore((s) => s.state.agents);
  if (!tasks.length) return <EmptyState icon={ListTodo} title="No tasks" description="The board fills in when the team plans a run." />;
  const done = tasks.filter((x) => x.status === "done").length;
  return (
    <View>
      <SectionLabel>{`Tasks · ${done}/${tasks.length}`}</SectionLabel>
      <Card>
        <View style={{ paddingHorizontal: space(4), paddingTop: space(4), paddingBottom: space(1) }}>
          <Progress value={(done / tasks.length) * 100} color={t.success} />
        </View>
        <View style={{ paddingHorizontal: space(3), paddingBottom: space(3) }}>
          {tasks.map((task) => {
            const who = agents[task.assignedTo ?? task.role ?? ""];
            return (
              <View key={task.id} style={{ flexDirection: "row", gap: space(2.5), paddingHorizontal: space(1), paddingVertical: space(2) }}>
                <Text mono size={type.sm} style={{ width: 14, textAlign: "center", color: resolveColor(t, statusColor(task.status)) }}>
                  {TASK_GLYPH[task.status]}
                </Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text size={type.sm} tone={task.status === "done" ? "mutedForeground" : "foreground"}>
                    {task.description}
                  </Text>
                  <Text mono size={type.label} tone="mutedForeground">
                    {`${task.id} · ${task.status.replace("_", " ")}${who ? ` · ${who.cfg.role}` : ""}`}
                  </Text>
                </View>
                {who && <PixelAvatar slot={who.index} size={18} />}
              </View>
            );
          })}
        </View>
      </Card>
    </View>
  );
}

interface Worktree {
  active?: boolean;
  branch?: string;
  diffStat?: string;
}

function Changes() {
  const t = useTheme();
  const summary = useStore((s) => s.state.summary);
  const touched = useStore((s) => s.state.touched);
  const running = useStore((s) => s.state.active || goalLive(s.state.goalStatus));
  const [wt, setWt] = useState<Worktree>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useStore
      .getState()
      .call<Worktree>("GET", "/worktree")
      .then(setWt)
      .catch(() => {});
  }, [running]);
  const edited = Object.entries(touched).filter(([, k]) => k !== "R");
  const act = (what: "merge" | "discard") =>
    alert(what === "merge" ? "Merge into your project?" : "Throw these changes away?", what === "merge" ? `Brings ${wt?.branch} into the project on your Mac.` : "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: what === "merge" ? "Merge" : "Discard",
        style: what === "merge" ? "default" : "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            const r = await useStore.getState().call<{ ok: boolean; message: string }>("POST", `/worktree/${what}`);
            alert(r.ok ? "Done" : "Couldn't do that", r.message);
            setWt(await useStore.getState().call<Worktree>("GET", "/worktree"));
          } catch (err) {
            alert("Couldn't do that", err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        },
      },
    ]);

  if (!wt?.active && !summary && !edited.length) return <EmptyState icon={FileDiff} title="No changes yet" description="Files the team writes show up here." />;
  return (
    <View style={{ gap: space(4) }}>
      {wt?.active && (
        <Card>
          <CardHeader
            icon={<GitBranch color={t.primary} size={16} style={{ marginTop: 2 }} />}
            title={
              <Text mono size={type.sm} weight="medium" lines={1}>
                {wt.branch}
              </Text>
            }
            description={running ? "Merging waits until the run or goal stops." : "Waiting in its own worktree. Merge it into the project, or throw it away."}
          />
          {!!wt.diffStat && (
            <CardContent>
              <CodeBlock lines={10}>{wt.diffStat}</CodeBlock>
            </CardContent>
          )}
          <CardFooter>
            <Button size="sm" title="Merge" icon={GitMerge} onPress={() => act("merge")} busy={busy} disabled={running} style={{ flex: 1 }} />
            <Button size="sm" variant="outline" title="Discard" icon={Trash2} tone="destructive" onPress={() => act("discard")} disabled={running || busy} />
          </CardFooter>
        </Card>
      )}
      {summary && (
        <View>
          <SectionLabel>Last run</SectionLabel>
          <Card>
            {!!summary.summary && (
              <CardContent>
                <Text size={type.sm} selectable>
                  {summary.summary}
                </Text>
              </CardContent>
            )}
            {summary.files.map((f, i) => (
              <View key={f.path}>
                {(i > 0 || !!summary.summary) && <Separator />}
                <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(4), paddingVertical: space(2.5) }}>
                  <Text mono size={type.xs} lines={1} style={{ flex: 1 }}>
                    {f.path}
                  </Text>
                  <Text mono size={type.label} tone="success">{`+${f.added}`}</Text>
                  {f.removed > 0 && <Text mono size={type.label} tone="destructive">{`−${f.removed}`}</Text>}
                </View>
              </View>
            ))}
          </Card>
        </View>
      )}
      {!!edited.length && (
        <View>
          <SectionLabel>{`Changed this session · ${edited.length}`}</SectionLabel>
          <Card>
            <View style={{ paddingHorizontal: space(4), paddingVertical: space(3), gap: space(1.5) }}>
              {edited.map(([path, k]) => (
                <View key={path} style={{ flexDirection: "row", gap: space(2) }}>
                  <Text mono size={type.xs} style={{ width: 12, color: k === "A" ? t.success : t.primary }}>
                    {k === "A" ? "+" : "~"}
                  </Text>
                  <Text mono size={type.xs} tone="mutedForeground" lines={1} style={{ flex: 1 }}>
                    {path}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
        </View>
      )}
    </View>
  );
}

function SessionMenu() {
  const active = useStore((s) => s.state.active);
  const awake = useStore((s) => s.state.awake);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      const r = (await fn()) as { message?: string } | undefined;
      if (r?.message) alert("niti", r.message);
    } catch (err) {
      alert("niti", err instanceof Error ? err.message : String(err));
    }
  };
  const s = useStore.getState();
  const open = () =>
    alert("This project", undefined, [
      ...(active ? [{ text: "Stop the run", style: "destructive" as const, onPress: () => void run(() => s.call("POST", "/cancel")) }] : []),
      awake === "off" ? { text: "Keep the Mac awake", onPress: () => void run(() => s.command("awake")) } : { text: "Let the Mac sleep", onPress: () => void run(() => s.command("awake", "off")) },
      { text: "Status", onPress: () => void run(() => s.command("status")) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  return <Button variant="outline" size="sm" icon={Ellipsis} title="Actions" label="Project actions: stop the run, keep the Mac awake, status" onPress={open} />;
}

// The desktop composer: a rounded card holding the text and a toolbar, who it goes to on the left,
// a round send button on the right. What it does depends on what's running, as there.
function Composer() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const state = useStore((s) => s.state);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const live = goalLive(state.goalStatus);
  const to = state.active ? steerTarget(state) : undefined;
  const placeholder = live ? "A note for the goal…" : state.active ? `Message ${state.agents[to ?? ""]?.cfg.role ?? "the team"}…` : "What should the team do?";
  const target = text.startsWith("/") ? "command" : live ? "the goal, next round" : state.active ? (state.agents[to ?? ""]?.cfg.role ?? "the team") : "the team";
  const suggestions = !state.active && !live && !text ? (state.summary?.next ?? []).slice(0, 3) : [];
  const stop = state.active && !live;

  const send = async (raw: string) => {
    const msg = raw.trim();
    if (!msg) return;
    setBusy(true);
    const s = useStore.getState();
    try {
      if (msg.startsWith("/")) {
        const [name = "", ...rest] = msg.slice(1).split(" ");
        const r = await s.command(name, rest.join(" "));
        if (r.message) alert(`/${name}`, r.message);
      } else if (live) {
        await s.command("goal", `note ${msg}`);
      } else if (state.active) {
        if (!to) throw new Error("nobody is working right now");
        await s.call("POST", `/agents/${encodeURIComponent(to)}/message`, { text: msg });
      } else {
        await s.call("POST", "/prompt", { text: msg, mode: "build" });
      }
      setText("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      alert("Not sent", err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <View style={{ paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: Math.max(insets.bottom, space(3)), gap: space(2), backgroundColor: t.background }}>
      {!!suggestions.length && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
          {suggestions.map((sg) => (
            <Pressable
              key={sg}
              accessibilityRole="button"
              accessibilityLabel={`Use suggestion: ${sg}`}
              onPress={() => setText(sg)}
              style={({ pressed }) => ({
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: pressed ? t.accent : t.card,
                borderRadius: radius.full,
                paddingHorizontal: space(3),
                height: 36,
                justifyContent: "center",
                maxWidth: 280,
              })}
            >
              <Text size={type.xs} lines={1}>
                {sg}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={{ borderRadius: radius.xl, borderWidth: 1, borderColor: focused ? alpha(t.primary, 0.5) : state.active ? alpha(t.info, 0.3) : t.border, backgroundColor: t.card }}>
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={t.mutedForeground}
          selectionColor={t.primary}
          accessibilityLabel={placeholder}
          multiline
          style={{
            minHeight: 48,
            maxHeight: 140,
            color: t.foreground,
            paddingHorizontal: space(4),
            paddingTop: 13,
            paddingBottom: space(1),
            fontSize: 16,
            fontFamily: text.startsWith("/") ? fonts.mono.regular : fonts.sans.regular,
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingLeft: space(4), paddingRight: space(1.5), height: TOUCH + 4 }}>
          <Users color={t.mutedForeground} size={12} />
          <Text size={type.label} tone="mutedForeground" lines={1} style={{ flex: 1 }}>
            {"To: "}
            <Text size={type.label} weight="medium">
              {target}
            </Text>
          </Text>
          {stop && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop the run"
              onPress={() =>
                alert("Stop the run?", "Every agent stops what it's doing.", [
                  { text: "Keep going", style: "cancel" },
                  { text: "Stop", style: "destructive", onPress: () => void useStore.getState().call("POST", "/cancel") },
                ])
              }
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                borderRadius: 18,
                borderWidth: 1,
                borderColor: t.input,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? t.accent : "transparent",
              })}
              hitSlop={4}
            >
              <Square color={t.foreground} fill={t.foreground} size={11} />
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={busy || !text.trim()}
            onPress={() => void send(text)}
            hitSlop={4}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: t.primary,
              alignItems: "center",
              justifyContent: "center",
              opacity: busy || !text.trim() ? 0.5 : pressed ? 0.9 : 1,
            })}
          >
            {busy ? <Spinner tone="primaryForeground" size={type.sm} /> : <ArrowUp color={t.primaryForeground} size={18} />}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
