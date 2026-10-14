import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text as RNText, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { mono, radius, space, useTheme } from "@/lib/theme";

// The handful of building blocks every screen uses, on niti's tokens (lib/theme.ts). Native
// controls where iOS has them (the system font, TextInput, sheets from the router); these only add
// niti's colours, a 44pt minimum touch target and pressed feedback.

type Tone = "default" | "muted" | "primary" | "success" | "warning" | "destructive";

export function Text({ children, tone = "default", size = 16, weight, mono: isMono, style, lines }: { children: ReactNode; tone?: Tone; size?: number; weight?: TextStyle["fontWeight"]; mono?: boolean; style?: StyleProp<TextStyle>; lines?: number }) {
  const t = useTheme();
  const color = tone === "default" ? t.foreground : tone === "muted" ? t.muted : t[tone];
  return (
    <RNText numberOfLines={lines} maxFontSizeMultiplier={1.6} style={[{ color, fontSize: size, lineHeight: Math.round(size * 1.4), fontWeight: weight, fontFamily: isMono ? mono : undefined }, style]}>
      {children}
    </RNText>
  );
}

export function Button({ title, onPress, kind = "primary", busy, disabled, icon, style, label }: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "destructive" | "ghost"; busy?: boolean; disabled?: boolean; icon?: ReactNode; style?: StyleProp<ViewStyle>; label?: string }) {
  const t = useTheme();
  const bg = kind === "primary" ? t.primary : kind === "destructive" ? t.destructive : kind === "secondary" ? t.raised : "transparent";
  const fg = kind === "primary" ? t.primaryForeground : kind === "destructive" ? t.background : kind === "ghost" ? t.primary : t.foreground;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        { minHeight: 48, paddingHorizontal: space(4), borderRadius: radius, backgroundColor: bg, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: space(2), opacity: off ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <RNText style={{ color: fg, fontSize: 16, fontWeight: "600" }} maxFontSizeMultiplier={1.4}>
        {title}
      </RNText>
    </Pressable>
  );
}

export function Card({ children, style, onPress, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string }) {
  const t = useTheme();
  const base: ViewStyle = { backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: radius, padding: space(4), gap: space(2) };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.85 : 1 }, style]}>
      {children}
    </Pressable>
  );
}

export function Chip({ text, tone = "muted", icon }: { text: string; tone?: Tone; icon?: ReactNode }) {
  const t = useTheme();
  const color = tone === "default" ? t.foreground : tone === "muted" ? t.muted : t[tone];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(1), paddingHorizontal: space(2), paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: t.border, backgroundColor: t.raised, alignSelf: "flex-start" }}>
      {icon}
      <RNText style={{ color, fontSize: 13, fontWeight: "500" }} maxFontSizeMultiplier={1.4}>
        {text}
      </RNText>
    </View>
  );
}

export function Field({ label, hint, error, ...input }: TextInputProps & { label: string; hint?: string; error?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space(1.5) }}>
      <Text size={14} weight="600">
        {label}
      </Text>
      <TextInput
        placeholderTextColor={t.muted}
        accessibilityLabel={label}
        {...input}
        style={[{ minHeight: 48, borderRadius: radius, borderWidth: 1, borderColor: error ? t.destructive : t.border, backgroundColor: t.card, color: t.foreground, paddingHorizontal: space(3), fontSize: 17 }, input.style]}
      />
      {error ? (
        <Text size={14} tone="destructive" style={{ marginTop: 2 }}>
          {error}
        </Text>
      ) : hint ? (
        <Text size={14} tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Code({ children, tone = "default", lines }: { children: string; tone?: Tone; lines?: number }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.raised, borderRadius: radius - 4, padding: space(3) }}>
      <Text mono size={13} tone={tone} lines={lines} style={{ lineHeight: 19 }}>
        {children}
      </Text>
    </View>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <View style={{ paddingVertical: space(12), paddingHorizontal: space(6), gap: space(2), alignItems: "center" }}>
      <Text size={18} weight="600" style={{ textAlign: "center" }}>
        {title}
      </Text>
      <Text tone="muted" style={{ textAlign: "center" }}>
        {body}
      </Text>
      {action}
    </View>
  );
}
