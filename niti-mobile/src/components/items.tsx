import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { BookOpen, Brain, Check, ChevronRight, CircleAlert, CircleCheck, CircleX, ShieldCheck, CornerDownRight, FilePen, FilePlus2, FileSearch, FileText, FolderTree, ListChecks, ScanSearch, Search, Stethoscope, Terminal, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react-native";
import type { Item, RenderItem } from "../../../niti-app/src/renderer/src/lib/reducer";
import type { AcceptCheck, Todo } from "../../../niti-app/src/renderer/src/lib/types";
import { fmtDur, groupLabel, PAST_VERB } from "../../../niti-app/src/renderer/src/lib/humanize";
import { toRows } from "../../../niti-app/src/renderer/src/lib/diff";
import { alpha, radius, space, type, useTheme } from "@/lib/theme";
import { Card, CardContent, CardHeader, Spinner, Text } from "./ui";

// An agent's transcript, row for row as the desktop app draws it (features/session/items.tsx): tool
// calls as quiet one-liners with a check or a spinner, shell output and diffs in bordered blocks,
// notes by tone, your own messages as bubbles on the right.

const VERB_ICON: Record<string, LucideIcon> = {
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  List: FolderTree,
  Find: FileSearch,
  Search: Search,
  Run: Terminal,
  Check: Stethoscope,
  Inspect: ScanSearch,
  Remember: Brain,
  Recall: BookOpen,
  Plan: ListChecks,
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{fmtDur(Math.max(0, now - since))}</>;
}

const ToolRow = memo(function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const t = useTheme();
  const Icon = VERB_ICON[item.verb] ?? Wrench;
  const running = item.status === "running";
  const failed = item.status === "fail";
  return (
    <View style={{ paddingVertical: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <View style={{ width: 16, alignItems: "center" }}>{running ? <Spinner size={type.sm} /> : failed ? <X color={t.destructive} size={14} /> : <Check color={t.success} size={14} />}</View>
        <Icon color={t.mutedForeground} size={14} />
        <Text size={type.sm} tone={running ? "foreground" : "mutedForeground"}>
          {running ? item.verb : (PAST_VERB[item.verb] ?? item.verb)}
        </Text>
        {!!item.target && (
          <Text mono size={type.xs} lines={1} style={{ flex: 1 }}>
            {item.target}
          </Text>
        )}
        <Text size={type.label} tone="mutedForeground" style={{ marginLeft: "auto", fontVariant: ["tabular-nums"] }}>
          {running ? <Elapsed since={item.startedAt} /> : item.durationMs !== undefined ? fmtDur(item.durationMs) : ""}
        </Text>
      </View>
      {running && !!item.live?.length && (
        <View style={{ marginLeft: 24, marginTop: 2, borderLeftWidth: 2, borderColor: alpha(t.primary, 0.3), backgroundColor: alpha(t.mutedForeground, 0.08), borderRadius: radius.sm, paddingHorizontal: space(2.5), paddingVertical: space(1) }}>
          {item.live.slice(-4).map((l, i) => (
            <Text key={i} mono size={type.label} tone="mutedForeground" lines={1}>
              {l || " "}
            </Text>
          ))}
        </View>
      )}
      {failed && !!item.error && (
        <Text selectable size={type.xs} tone="destructive" style={{ marginLeft: 24, marginTop: 2 }}>
          {item.error}
        </Text>
      )}
    </View>
  );
});

function GroupRow({ item }: { item: Extract<RenderItem, { kind: "group" }> }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const Icon = VERB_ICON[item.verb] ?? Wrench;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 40 }}>
        <View style={{ width: 16, alignItems: "center" }}>
          <Check color={t.success} size={14} />
        </View>
        <Icon color={t.mutedForeground} size={14} />
        <Text size={type.sm} tone="mutedForeground">
          {groupLabel(item.verb, item.items.length, "")}
        </Text>
        <ChevronRight color={t.mutedForeground} size={13} style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }} />
        <Text size={type.label} tone="mutedForeground" style={{ marginLeft: "auto" }}>
          {fmtDur(item.durationMs)}
        </Text>
      </Pressable>
      {open && (
        <View style={{ marginLeft: 34, borderLeftWidth: 1, borderColor: t.border, paddingLeft: space(3) }}>
          {item.items.map((x) => (
            <Text key={x.id} mono size={type.xs} lines={1}>
              {x.target}
              {!!x.outcome && <Text size={type.label} tone="mutedForeground">{` · ${x.outcome}`}</Text>}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function ShellBlock({ item }: { item: Extract<Item, { kind: "shell" }> }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const shown = open ? item.body : item.body.slice(0, 3);
  const hidden = Math.max(item.lines, item.body.length) - shown.length;
  const tone = item.ok ? t.success : t.destructive;
  return (
    <View style={{ marginVertical: space(1), borderRadius: radius.lg, borderWidth: 1, borderColor: item.ok ? t.border : alpha(t.destructive, 0.4), backgroundColor: t.card, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: 7, borderBottomWidth: 1, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.06) }}>
        <Terminal color={t.mutedForeground} size={14} />
        <Text mono selectable size={type.xs} lines={1} style={{ flex: 1 }}>
          {item.command}
        </Text>
        {item.ok ? <Check color={tone} size={12} /> : <X color={tone} size={12} />}
        <Text size={type.label} style={{ color: tone }}>
          {item.exitCode !== undefined ? `exit ${item.exitCode}` : item.ok ? "ok" : "failed"}
        </Text>
        <Text size={type.label} tone="mutedForeground">
          {fmtDur(item.durationMs)}
        </Text>
      </View>
      {!!item.outcome && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space(3), paddingTop: 6 }}>
          <CornerDownRight color={t.mutedForeground} size={12} />
          <Text size={type.xs} tone={item.ok ? "foreground" : "destructive"} style={{ flex: 1 }}>
            {item.outcome}
          </Text>
        </View>
      )}
      {shown.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text mono selectable size={type.label} tone="mutedForeground" style={{ paddingHorizontal: space(3), paddingVertical: 6 }}>
            {shown.join("\n")}
          </Text>
        </ScrollView>
      )}
      {hidden > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ paddingHorizontal: space(3), minHeight: 36, justifyContent: "center" }}>
          <Text size={type.label} tone="mutedForeground">
            {open ? "Show less" : `+${hidden} lines`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function DiffRows({ hunks, more = 0, fold = 12 }: { hunks: Extract<Item, { kind: "diff" }>["hunks"]; more?: number; fold?: number }) {
  const t = useTheme();
  const rows = toRows(hunks);
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, fold);
  const hidden = rows.length - shown.length + more;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ paddingVertical: space(1), minWidth: "100%" }}>
          {shown.map((r, i) =>
            r.kind === "gap" ? (
              <Text key={i} mono size={type.label} tone="mutedForeground" style={{ paddingHorizontal: space(3), opacity: 0.5 }}>
                ⋯
              </Text>
            ) : (
              <View key={i} style={{ flexDirection: "row", backgroundColor: r.kind === "+" ? alpha(t.success, 0.1) : r.kind === "-" ? alpha(t.destructive, 0.1) : "transparent" }}>
                <Text mono size={type.label} tone="mutedForeground" style={{ width: 36, textAlign: "right", paddingRight: 6, opacity: 0.6, fontVariant: ["tabular-nums"] }}>
                  {r.n ?? ""}
                </Text>
                <Text mono size={type.label} style={{ width: 16, color: r.kind === "+" ? t.success : r.kind === "-" ? t.destructive : t.mutedForeground }}>
                  {r.kind === " " ? "" : r.kind === "-" ? "−" : "+"}
                </Text>
                <Text mono selectable size={type.label} tone={r.kind === " " ? "mutedForeground" : "foreground"} style={{ paddingRight: space(4) }}>
                  {r.text}
                </Text>
              </View>
            ),
          )}
        </View>
      </ScrollView>
      {hidden > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ paddingLeft: 36, minHeight: 32, justifyContent: "center" }}>
          <Text size={type.label} tone="mutedForeground">
            {open ? "Show less" : `${hidden} more lines`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function DiffBlock({ item }: { item: Extract<Item, { kind: "diff" }> }) {
  const t = useTheme();
  const Icon = item.created ? FilePlus2 : FilePen;
  return (
    <View style={{ marginVertical: space(1), borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.card, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: 7, borderBottomWidth: item.hunks.length ? 1 : 0, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.06) }}>
        <Icon color={item.created ? t.success : t.primary} size={14} />
        <Text size={type.xs} tone="mutedForeground">
          {item.created ? "Created" : "Updated"}
        </Text>
        <Text mono size={type.xs} weight="medium" lines={1} style={{ flex: 1 }}>
          {item.path}
        </Text>
        <Text mono size={type.label} tone="success">{`+${item.added}`}</Text>
        {item.removed > 0 && <Text mono size={type.label} tone="destructive">{`−${item.removed}`}</Text>}
      </View>
      {item.hunks.length > 0 && <DiffRows hunks={item.hunks} more={item.more} />}
    </View>
  );
}

function NoteRow({ item }: { item: Extract<Item, { kind: "note" }> }) {
  const t = useTheme();
  switch (item.tone) {
    case "thought":
      return (
        <Text selectable size={type.sm} tone="mutedForeground" style={{ paddingVertical: 3, paddingLeft: 24, fontStyle: "italic" }}>
          {item.text}
        </Text>
      );
    case "step":
      return (
        <View style={{ flexDirection: "row", gap: space(2), paddingVertical: 3 }}>
          <Text mono size={type.sm} tone="primary" style={{ width: 16, textAlign: "center" }}>
            ▸
          </Text>
          <Text selectable size={type.sm} weight="medium" tone="primary" style={{ flex: 1 }}>
            {item.text}
          </Text>
        </View>
      );
    case "warning":
    case "error": {
      const c = item.tone === "warning" ? t.warning : t.destructive;
      const Icon = item.tone === "warning" ? TriangleAlert : X;
      return (
        <View style={{ flexDirection: "row", gap: space(2), marginVertical: space(1), borderRadius: radius.md, backgroundColor: alpha(c, 0.1), paddingHorizontal: space(2.5), paddingVertical: space(1.5) }}>
          <Icon color={c} size={14} style={{ marginTop: 2 }} />
          <Text selectable size={type.sm} style={{ color: c, flex: 1 }}>
            {item.text}
          </Text>
        </View>
      );
    }
    case "user":
      return (
        <View style={{ alignItems: "flex-end", marginVertical: space(1.5) }}>
          <View style={{ maxWidth: "85%", borderRadius: 18, borderBottomRightRadius: 6, backgroundColor: alpha(t.primary, 0.12), paddingHorizontal: space(3), paddingVertical: space(1.5) }}>
            <Text selectable size={type.base}>
              {item.text}
            </Text>
          </View>
        </View>
      );
    default:
      return (
        <Text selectable size={type.sm} tone="mutedForeground" style={{ paddingVertical: 3, paddingLeft: 24 }}>
          {item.text}
        </Text>
      );
  }
}

export const ItemView = memo(function ItemView({ item }: { item: RenderItem }) {
  const t = useTheme();
  switch (item.kind) {
    case "text":
      return (
        <Text selectable size={type.base} style={{ paddingVertical: space(1.5) }}>
          {item.text}
          {item.streaming && <Text tone="primary">▍</Text>}
        </Text>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "group":
      return <GroupRow item={item} />;
    case "shell":
      return <ShellBlock item={item} />;
    case "diff":
      return <DiffBlock item={item} />;
    case "note":
      return <NoteRow item={item} />;
    case "checks":
      return <ChecksCard checks={item.checks} />;
    case "plan-done":
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingVertical: 3 }}>
          <View style={{ width: 16, alignItems: "center" }}>
            <ListChecks color={t.success} size={14} />
          </View>
          <Text size={type.sm} tone="mutedForeground">{`Plan finished · ${item.steps} steps`}</Text>
        </View>
      );
  }
});

// niti's acceptance checks on a local agent's work, as the desktop's card shows them: failures first,
// each with what to fix; what passed folded behind a 44pt toggle.
function ChecksCard({ checks }: { checks: AcceptCheck[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const failing = checks.filter((c) => !c.ok).sort((a, b) => (a.grade === b.grade ? 0 : a.grade === "must" ? -1 : 1));
  const passed = checks.filter((c) => c.ok);
  const ok = failing.length === 0;
  return (
    <Card style={{ marginVertical: space(1.5) }}>
      <CardHeader
        icon={<ShieldCheck color={ok ? t.success : t.warning} size={16} style={{ marginTop: 2 }} />}
        title={ok ? "niti checked the work — all clear" : "niti checked the work — not done yet"}
        action={
          <Text mono size={type.xs} tone="mutedForeground">
            {`${passed.length}/${checks.length} pass`}
          </Text>
        }
      />
      <CardContent style={{ paddingTop: space(2) }}>
        {failing.map((c) => {
          const Icon = c.grade === "must" ? CircleX : CircleAlert;
          return (
            <View key={c.name} style={{ flexDirection: "row", gap: space(2) }}>
              <Icon color={c.grade === "must" ? t.destructive : t.warning} size={15} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text size={type.sm} weight="medium">
                  {c.name}
                </Text>
                {c.detail ? (
                  <Text selectable size={type.sm} tone="mutedForeground">
                    {c.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
        {passed.length > 0 && !ok && (
          <Pressable accessibilityRole="button" accessibilityLabel={open ? "Hide the checks that passed" : "Show the checks that passed"} onPress={() => setOpen(!open)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space(1) }}>
            <ChevronRight color={t.mutedForeground} size={14} style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }} />
            <Text size={type.sm} tone="mutedForeground">{`${passed.length} passed`}</Text>
          </Pressable>
        )}
        {(open || ok) &&
          passed.map((c) => (
            <View key={c.name} style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
              <CircleCheck color={t.success} size={15} />
              <Text size={type.sm} tone="mutedForeground" style={{ flex: 1 }}>
                {c.name}
              </Text>
            </View>
          ))}
      </CardContent>
    </Card>
  );
}

// The agent's own checklist, as the app shows it above the transcript.
export function TodoList({ todos, color }: { todos: Todo[]; color: string }) {
  const t = useTheme();
  const done = todos.filter((x) => x.status === "done").length;
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.05), paddingHorizontal: space(3), paddingVertical: space(2), gap: space(1.5) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <ListChecks color={t.mutedForeground} size={14} />
        <Text size={type.label} weight="medium" tone="mutedForeground" style={{ flex: 1 }}>
          Plan
        </Text>
        <Text mono size={type.label} tone="mutedForeground">{`${done}/${todos.length}`}</Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: t.muted, overflow: "hidden" }}>
        <View style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%`, height: "100%", backgroundColor: color }} />
      </View>
      {todos.map((x, i) => (
        <View key={i} style={{ flexDirection: "row", gap: space(2) }}>
          <Text mono size={type.sm} style={{ color: x.status === "done" ? t.success : x.status === "doing" ? t.primary : alpha(t.mutedForeground, 0.6) }}>
            {x.status === "done" ? "☑" : x.status === "doing" ? "◼" : "☐"}
          </Text>
          <Text size={type.sm} weight={x.status === "doing" ? "medium" : "regular"} tone={x.status === "done" ? "mutedForeground" : "foreground"} style={{ flex: 1, textDecorationLine: x.status === "done" ? "line-through" : "none" }}>
            {x.text}
          </Text>
        </View>
      ))}
    </View>
  );
}
