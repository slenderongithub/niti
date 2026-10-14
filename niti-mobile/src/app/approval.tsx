import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { ShieldAlert } from "lucide-react-native";
import { useStore } from "@/lib/store";
import { resolveColor, space, useTheme } from "@/lib/theme";
import { Button, Chip, Code, Empty, Text } from "@/components/ui";
import type { ApprovalRequest } from "../../../niti-app/src/renderer/src/lib/types";

// The request at the front of the queue, answered the way the Mac's own approval screens do: allow
// once, allow for this agent (or this folder), or deny. A risky one needs Face ID first, and is never
// covered by "always".
export default function Approval() {
  const t = useTheme();
  const approvals = useStore((s) => s.state.approvals);
  const agents = useStore((s) => s.state.agents);
  const head = approvals[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!head) return <Empty title="Nothing waiting" body="Every request has been answered." action={<Button kind="secondary" title="Close" onPress={() => router.back()} />} />;

  const agent = agents[head.agentId];
  const { verb, target, body } = describe(head);

  const answer = async (ok: boolean, scope?: "agent" | "path") => {
    setError(undefined);
    if (ok && head.dangerous) {
      const auth = await LocalAuthentication.authenticateAsync({ promptMessage: `Allow ${agent?.cfg.role ?? head.agentId} to ${verb}` });
      if (!auth.success) return;
    }
    setBusy(true);
    try {
      await useStore.getState().call("POST", "/approval", { ok, id: head.id, ...(scope ? { scope } : {}) });
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
    <ScrollView contentContainerStyle={{ padding: space(5), gap: space(4) }}>
      <View style={{ gap: space(2) }}>
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          {head.dangerous && <Chip text="Risky" tone="destructive" icon={<ShieldAlert color={t.destructive} size={14} />} />}
          {approvals.length > 1 && <Chip text={`1 of ${approvals.length}`} />}
        </View>
        <Text size={20} weight="600">
          <Text size={20} weight="600" style={{ color: agent ? resolveColor(t, agent.color) : t.foreground }}>
            {agent?.cfg.role ?? head.agentId}
          </Text>
          {` wants to ${verb}`}
        </Text>
        {!!target && (
          <Text mono size={14} tone="muted">
            {target}
          </Text>
        )}
      </View>
      {!!body && <Code lines={40}>{body}</Code>}
      {!!error && <Text tone="destructive">{error}</Text>}
      <View style={{ gap: space(2) }}>
        <Button title={head.dangerous ? "Allow with Face ID" : "Allow"} onPress={() => void answer(true)} busy={busy} />
        {!head.dangerous && <Button kind="secondary" title={`Always allow for ${agent?.cfg.role ?? "this agent"}`} onPress={() => void answer(true, "agent")} disabled={busy} />}
        {!head.dangerous && typeof head.input.path === "string" && <Button kind="secondary" title="Always allow in this folder" onPress={() => void answer(true, "path")} disabled={busy} />}
        <Button kind="ghost" title="Deny" onPress={() => void answer(false)} disabled={busy} />
      </View>
    </ScrollView>
  );
}

function describe(r: ApprovalRequest): { verb: string; target: string; body: string } {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (r.tool === "shell" || r.tool === "bash") {
    const args = Array.isArray(r.input.args) ? (r.input.args as unknown[]).map(String) : [];
    return { verb: "run a command", target: "", body: [s(r.input.command), ...args].join(" ").trim() };
  }
  if (r.tool === "write_file" || r.tool === "edit") return { verb: r.tool === "edit" ? "edit a file" : "write a file", target: s(r.input.path), body: s(r.input.diff) || s(r.input.content) };
  return { verb: `use ${r.tool}`, target: s(r.input.path), body: JSON.stringify(r.input, null, 2) };
}
