import { useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowUp, Hand, MessageSquareDashed } from "lucide-react-native";
import { groupItems } from "../../../../../../../niti-app/src/renderer/src/lib/reducer";
import { statusColor } from "../../../../../../../niti-app/src/renderer/src/lib/identity";
import { fmtTokens } from "../../../../../../../niti-app/src/renderer/src/lib/format";
import { useStore } from "@/lib/store";
import { alpha, fonts, radius, resolveColor, space, TOUCH, type, useTheme } from "@/lib/theme";
import { EmptyState, Progress, Spinner, Text } from "@/components/ui";
import { AgentAvatar } from "@/components/avatar";
import { ItemView, TodoList } from "@/components/items";

// One agent's transcript, as the desktop app's focused agent panel shows it, with a way to talk to
// it: send (it reads it at its next turn) or interrupt (it stops now and carries on from your words).
export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const a = useStore((s) => s.state.agents[id]);
  const lead = useStore((s) => s.state.leadId === id);
  const items = useMemo(() => (a ? groupItems(a.items).slice(-150) : []), [a]);
  const scroll = useRef<ScrollView>(null);
  const [follow, setFollow] = useState(true);

  if (!a) return <EmptyState icon={MessageSquareDashed} title="No such agent" description="It isn't on this project's team any more." />;
  const color = resolveColor(t, a.color);
  const ctx = a.ctxLimit ? Math.min(100, Math.round((a.usage.lastInput * 100) / a.ctxLimit)) : 0;

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={90} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: a.cfg.role }} />
      <ScrollView
        ref={scroll}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => follow && scroll.current?.scrollToEnd({ animated: false })}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 80);
        }}
        scrollEventThrottle={100}
        contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(4), gap: 2 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(3) }}>
          <AgentAvatar slot={a.index} lead={lead} status={a.status} size={44} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
              <Text size={type.lg} weight="semibold" style={{ color }}>
                {a.cfg.role}
              </Text>
              <Text size={type.label} style={{ color: resolveColor(t, statusColor(a.status)) }}>
                {a.status}
              </Text>
            </View>
            <Text mono size={type.label} tone="mutedForeground" lines={1}>
              {a.cfg.model}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingBottom: space(3) }}>
          <Text size={type.label} tone="mutedForeground">{`ctx ${ctx}%`}</Text>
          <Progress value={ctx} color={ctx >= 80 ? t.destructive : ctx >= 60 ? t.warning : color} />
          <Text mono size={type.label} tone="mutedForeground">{`${fmtTokens(a.usage.inputTokens + a.usage.outputTokens)} tok`}</Text>
        </View>
        {a.todos && a.todos.length > 0 && (
          <View style={{ paddingBottom: space(2) }}>
            <TodoList todos={a.todos} color={color} />
          </View>
        )}
        {items.length ? items.map((it) => <ItemView key={it.id} item={it} />) : <EmptyState icon={MessageSquareDashed} title="Nothing yet" description={`${a.cfg.role} hasn't done anything this session.`} />}
        {a.status === "working" && !!a.activity && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: space(2) }}>
            <Spinner size={type.xs} />
            <Text size={type.xs} tone="mutedForeground" lines={1} style={{ flex: 1 }}>
              {a.activity}
            </Text>
          </View>
        )}
      </ScrollView>
      <Reply id={a.id} role={a.cfg.role} working={a.status === "working"} />
    </KeyboardAvoidingView>
  );
}

function Reply({ id, role, working }: { id: string; role: string; working: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (interrupt: boolean) => {
    setBusy(true);
    try {
      await useStore.getState().call("POST", `/agents/${encodeURIComponent(id)}/${interrupt ? "interrupt" : "message"}`, { text: text.trim() });
      setText("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert(interrupt ? "Couldn't interrupt" : "Not sent", err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <View style={{ paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: Math.max(insets.bottom, space(3)), backgroundColor: t.background }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space(2), borderRadius: radius.xl, borderWidth: 1, borderColor: t.border, backgroundColor: t.card, paddingLeft: space(4), paddingRight: space(1.5), paddingVertical: 4 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={working ? `Tell ${role}…` : `${role} isn't working right now`}
          editable={working}
          placeholderTextColor={t.mutedForeground}
          selectionColor={t.primary}
          accessibilityLabel={`Message ${role}`}
          multiline
          style={{ flex: 1, minHeight: TOUCH, maxHeight: 120, color: t.foreground, fontSize: 16, fontFamily: fonts.sans.regular, paddingTop: 12, paddingBottom: 10 }}
        />
        {working && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Interrupt ${role}`}
              accessibilityHint="It stops what it's doing now and carries on from your message"
              onPress={() => void send(true)}
              disabled={busy}
              hitSlop={4}
              style={({ pressed }) => ({ height: 36, paddingHorizontal: space(3), marginBottom: 4, borderRadius: 18, borderWidth: 1, borderColor: alpha(t.warning, 0.5), flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: pressed ? alpha(t.warning, 0.12) : "transparent" })}
            >
              <Hand color={t.warning} size={14} />
              <Text size={type.xs} weight="medium" tone="warning">
                Interrupt
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send to ${role} at its next turn`}
              onPress={() => void send(false)}
              disabled={busy || !text.trim()}
              hitSlop={4}
              style={({ pressed }) => ({ width: 36, height: 36, marginBottom: 4, borderRadius: 18, backgroundColor: t.primary, alignItems: "center", justifyContent: "center", opacity: busy || !text.trim() ? 0.5 : pressed ? 0.9 : 1 })}
            >
              <ArrowUp color={t.primaryForeground} size={18} />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
