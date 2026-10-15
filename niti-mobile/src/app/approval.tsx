import { useMemo, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { Check, CheckCheck, FileCode2, FolderCheck, MessageSquareWarning, ScanFace, ShieldAlert, ShieldCheck, Terminal, X } from "lucide-react-native";
import { parseUnified } from "../../../niti-app/src/renderer/src/lib/diff";
import type { ApprovalRequest } from "../../../niti-app/src/renderer/src/lib/types";
import { useStore } from "@/lib/store";
import { alpha, fonts, radius, resolveColor, space, type, useTheme } from "@/lib/theme";
import { Badge, Button, CodeBlock, EmptyState, Separator, Text } from "@/components/ui";
import { AgentAvatar } from "@/components/avatar";
import { DiffRows } from "@/components/items";

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

// The same words the desktop's approval center uses.
function describe(r: ApprovalRequest): { verb: string; target: string } {
  const i = r.input;
  if (r.tool === "shell" || r.tool === "bash") return { verb: "run", target: [str(i.command), ...(Array.isArray(i.args) ? (i.args as unknown[]).map(String) : [])].join(" ").trim() };
  if (r.tool === "write_file") return { verb: "write", target: str(i.path) };
  if (r.tool === "edit") return { verb: "edit", target: str(i.path) };
  return { verb: `use ${r.tool}`, target: str(i.path ?? i.query ?? "") };
}

// The request at the front of the queue, laid out as the desktop's approval center: who wants to
// do what, the command or the diff, then allow, always, or deny (and say what to do instead). A
// risky one needs Face ID and is never covered by "always".
export default function Approval() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const approvals = useStore((s) => s.state.approvals);
  const agents = useStore((s) => s.state.agents);
  const lead = useStore((s) => s.state.leadId);
  const head = approvals[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tell, setTell] = useState<string>();
  const hunks = useMemo(() => (typeof head?.input.diff === "string" ? parseUnified(head.input.diff) : []), [head]);

  if (!head) return <EmptyState icon={ShieldCheck} title="Nothing waiting" description="Every request has been answered." action={<Button variant="outline" title="Close" onPress={() => router.back()} />} />;

  const agent = agents[head.agentId];
  const role = agent?.cfg.role ?? head.agentId;
  const d = describe(head);
  const isShell = head.tool === "shell" || head.tool === "bash";

  const answer = async (ok: boolean, scope?: "agent" | "path") => {
    setError(undefined);
    if (ok && head.dangerous) {
      const auth = await LocalAuthentication.authenticateAsync({ promptMessage: `Allow ${role} to ${d.verb}` });
      if (!auth.success) return;
    }
    setBusy(true);
    try {
      await useStore.getState().call("POST", "/approval", { ok, id: head.id, ...(scope ? { scope } : {}) });
      // Denied with a note: the agent hears what to do instead, as on the Mac.
      if (!ok && tell?.trim()) await useStore.getState().call("POST", `/agents/${encodeURIComponent(head.agentId)}/message`, { text: tell.trim() }).catch(() => {});
      setTell(undefined);
      void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
      if (useStore.getState().state.approvals.length <= 1) router.back();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Answered on the Mac (or another phone) first: the next one, if any, is already showing.
      setError(/no longer pending/.test(msg) ? "Already answered somewhere else." : msg);
    }
    setBusy(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: space(4) }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", gap: space(3), paddingHorizontal: space(5), paddingTop: space(6), paddingBottom: space(4), borderBottomWidth: 1, borderColor: t.border }}>
          {agent ? <AgentAvatar slot={agent.index} lead={head.agentId === lead} size={36} /> : <ShieldAlert color={t.warning} size={22} />}
          <View style={{ flex: 1, gap: space(1.5) }}>
            <Text size={type.lg} weight="semibold">
              <Text size={type.lg} weight="semibold" style={{ color: agent ? resolveColor(t, agent.color) : t.foreground }}>
                {role}
              </Text>
              <Text size={type.lg} tone="mutedForeground">{` wants to ${d.verb}`}</Text>
            </Text>
            {!isShell && !!d.target && (
              <Text mono size={type.xs} lines={2}>
                {d.target}
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: space(1.5), flexWrap: "wrap" }}>
              <Badge text={head.tool} variant="outline" mono icon={isShell ? Terminal : FileCode2} />
              {head.dangerous && <Badge text="risky" tone="destructive" icon={ShieldAlert} />}
              {approvals.length > 1 && <Badge text={`1 of ${approvals.length}`} />}
            </View>
          </View>
        </View>

        <View style={{ padding: space(4), gap: space(3) }}>
          {isShell ? (
            <>
              <CodeBlock icon={Terminal} title={<Text size={type.label} tone="mutedForeground">command</Text>} right={typeof head.input.cwd === "string" ? <Text mono size={type.label} tone="mutedForeground" lines={1}>{`in ${head.input.cwd}`}</Text> : undefined} tone="warning">
                {d.target}
              </CodeBlock>
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <ShieldAlert color={t.mutedForeground} size={13} style={{ marginTop: 2 }} />
                <Text size={type.xs} tone="mutedForeground" style={{ flex: 1 }}>
                  Runs in the project folder on your Mac. Network and paths outside the project always ask.
                </Text>
              </View>
            </>
          ) : hunks.length ? (
            <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.card, overflow: "hidden" }}>
              <DiffRows hunks={hunks} fold={60} />
            </View>
          ) : typeof head.input.content === "string" ? (
            <CodeBlock icon={FileCode2} title={<Text size={type.label} tone="mutedForeground">new file</Text>} lines={60} tone="foreground">
              {head.input.content}
            </CodeBlock>
          ) : (
            <CodeBlock lines={40}>{JSON.stringify(head.input, null, 2)}</CodeBlock>
          )}

          {tell !== undefined && (
            <View style={{ gap: space(2), borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.05), padding: space(3) }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                <MessageSquareWarning color={t.warning} size={14} />
                <Text size={type.xs} weight="medium">{`Deny, and tell ${role} what to do instead`}</Text>
              </View>
              <TextInput
                value={tell}
                onChangeText={setTell}
                autoFocus
                multiline
                placeholder="Don't touch the lockfile. Add the dependency with npm install instead."
                placeholderTextColor={t.mutedForeground}
                selectionColor={t.primary}
                accessibilityLabel={`What ${role} should do instead`}
                style={{ minHeight: 80, borderRadius: radius.md, borderWidth: 1, borderColor: t.input, backgroundColor: t.card, color: t.foreground, padding: space(3), fontSize: 16, fontFamily: fonts.sans.regular, textAlignVertical: "top" }}
              />
            </View>
          )}

          {!!error && (
            <Text size={type.sm} tone="destructive">
              {error}
            </Text>
          )}

          {approvals.length > 1 && (
            <View style={{ gap: space(1.5), paddingTop: space(1) }}>
              <Text size={type.label} weight="medium" tone="mutedForeground">
                Also waiting
              </Text>
              {approvals.slice(1, 5).map((r, i) => {
                const a = agents[r.agentId];
                const x = describe(r);
                return (
                  <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                    {r.dangerous ? <ShieldAlert color={t.destructive} size={12} /> : <View style={{ width: 12 }} />}
                    <Text size={type.xs} tone="mutedForeground">{`${a?.cfg.role ?? r.agentId} · ${x.verb}`}</Text>
                    <Text mono size={type.label} tone="mutedForeground" lines={1} style={{ flex: 1 }}>
                      {x.target}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <Separator />
      <View style={{ paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: Math.max(insets.bottom, space(3)), gap: space(2), backgroundColor: alpha(t.mutedForeground, 0.04) }}>
        {tell === undefined ? (
          <>
            <Button title={head.dangerous ? "Allow with Face ID" : "Allow"} icon={head.dangerous ? ScanFace : Check} onPress={() => void answer(true)} busy={busy} />
            {!head.dangerous && (
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <Button variant="outline" size="sm" title={`Always for ${role}`} icon={CheckCheck} onPress={() => void answer(true, "agent")} disabled={busy} style={{ flex: 1 }} />
                {typeof head.input.path === "string" && <Button variant="outline" size="sm" title="This folder" icon={FolderCheck} onPress={() => void answer(true, "path")} disabled={busy} style={{ flex: 1 }} />}
              </View>
            )}
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button variant="outline" size="sm" title="Deny" icon={X} tone="destructive" onPress={() => void answer(false)} disabled={busy} style={{ flex: 1 }} />
              <Button variant="ghost" size="sm" title="Deny and say why" icon={MessageSquareWarning} tone="mutedForeground" onPress={() => setTell("")} disabled={busy} style={{ flex: 1 }} />
            </View>
          </>
        ) : (
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Button variant="ghost" title="Back" onPress={() => setTell(undefined)} disabled={busy} tone="mutedForeground" />
            <Button variant="destructive" title={`Deny and tell ${role}`} icon={X} onPress={() => void answer(false)} busy={busy} disabled={!tell.trim()} style={{ flex: 1 }} />
          </View>
        )}
      </View>
    </View>
  );
}
