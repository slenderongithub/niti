import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text as RNText, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { alpha, fonts, radius, space, TOUCH, type, useTheme, type ColorToken, type Weight } from "@/lib/theme";
import { useTick } from "@/lib/ticker";

// The desktop app's building blocks (its shadcn/ui primitives in niti-app/src/renderer/src/components),
// redrawn for React Native on the same tokens: the same variants, radii, weights and quiet density,
// with every control reaching Apple's 44pt touch target.

export type Tone = ColorToken;

// ---- type ----

export function Text({
  children,
  tone = "foreground",
  size = type.base,
  weight = "regular",
  mono,
  style,
  lines,
  selectable,
  center,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: number;
  weight?: Weight;
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  lines?: number;
  selectable?: boolean;
  center?: boolean;
}) {
  const t = useTheme();
  return (
    <RNText
      numberOfLines={lines}
      selectable={selectable}
      maxFontSizeMultiplier={1.6}
      style={[{ color: t[tone], fontSize: size, lineHeight: Math.round(size * (mono ? 1.5 : 1.42)), fontFamily: (mono ? fonts.mono : fonts.sans)[weight], textAlign: center ? "center" : undefined }, style]}
    >
      {children}
    </RNText>
  );
}

// The desktop's section heading: "TEAM · 3", small, spaced capitals, muted.
export function SectionLabel({ children, action }: { children: string; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 28, paddingHorizontal: space(1), gap: space(2) }}>
      <RNText accessibilityRole="header" maxFontSizeMultiplier={1.4} style={{ flex: 1, color: t.mutedForeground, fontSize: type.label - 0.5, letterSpacing: 0.9, fontFamily: fonts.sans.semibold, textTransform: "uppercase" }}>
        {children}
      </RNText>
      {action}
    </View>
  );
}

// The TUI's wordmark, as the app draws it: "niti" in mono with the accent's full stop, over a bar.
export function Wordmark({ size = 17, align = "flex-start" }: { size?: number; align?: "flex-start" | "center" }) {
  const t = useTheme();
  return (
    <View accessible accessibilityLabel="niti" style={{ alignSelf: align }}>
      <RNText style={{ color: t.foreground, fontSize: size, fontFamily: fonts.mono.semibold, letterSpacing: -size * 0.02 }}>
        niti<RNText style={{ color: t.primary }}>.</RNText>
      </RNText>
      <View style={{ width: "62%", height: Math.max(2, Math.round(size / 10)), marginTop: Math.round(size / 12), borderRadius: 999, backgroundColor: t.primary }} />
    </View>
  );
}

// The TUI's braille spinner, on the shared clock.
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export function Spinner({ size = type.sm, tone = "primary" }: { size?: number; tone?: Tone }) {
  const t = useTheme();
  const tick = useTick();
  return (
    <RNText accessibilityElementsHidden importantForAccessibility="no" style={{ color: t[tone], fontSize: size, fontFamily: fonts.mono.regular, width: size * 0.62 }}>
      {FRAMES[tick % FRAMES.length]}
    </RNText>
  );
}

// ---- controls ----

type Variant = "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";

// shadcn's Button: default (accent fill), secondary, outline, ghost, destructive, link; sizes sm and
// default. A small one still answers a 44pt tap.
export function Button({
  title,
  onPress,
  variant = "default",
  size = "default",
  icon: Icon,
  busy,
  disabled,
  style,
  label,
  tone,
  haptic = true,
}: {
  title?: string;
  onPress: () => void;
  variant?: Variant;
  size?: "sm" | "default" | "lg" | "icon";
  icon?: LucideIcon;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  label?: string;
  tone?: Tone; // text colour override, e.g. an outline Deny in destructive
  haptic?: boolean;
}) {
  const t = useTheme();
  const bg: Record<Variant, string> = {
    default: t.primary,
    secondary: t.secondary,
    outline: t.dark ? alpha(t.input, 0.3) : t.background,
    ghost: "transparent",
    destructive: t.dark ? alpha(t.destructive, 0.6) : t.destructive,
    link: "transparent",
  };
  const fg = tone ? t[tone] : variant === "default" ? t.primaryForeground : variant === "destructive" ? "#ffffff" : variant === "link" ? t.primary : t.foreground;
  const h = size === "sm" ? 36 : size === "lg" ? 48 : TOUCH;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      hitSlop={size === "sm" ? 4 : undefined}
      onPress={() => {
        if (haptic) void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        {
          height: size === "icon" ? TOUCH : h,
          width: size === "icon" ? TOUCH : undefined,
          paddingHorizontal: size === "icon" ? 0 : size === "sm" ? space(3) : space(4),
          borderRadius: radius.md,
          backgroundColor: pressed && variant !== "link" ? (variant === "ghost" || variant === "outline" ? t.accent : alpha(bg[variant] === "transparent" ? t.accent : bg[variant], 0.9)) : bg[variant],
          borderWidth: variant === "outline" ? 1 : 0,
          borderColor: t.dark ? t.input : t.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space(2),
          opacity: off ? 0.5 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : Icon ? <Icon color={fg} size={size === "sm" ? 15 : 17} strokeWidth={2} /> : null}
      {!!title && (
        <RNText maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ color: fg, fontSize: size === "sm" ? type.sm : type.base, fontFamily: fonts.sans.medium }}>
          {title}
        </RNText>
      )}
    </Pressable>
  );
}

// shadcn's Badge: a small rounded-full label. `soft` is the app's coloured status text on a faint wash.
export function Badge({ text, tone = "mutedForeground", variant = "soft", icon: Icon, mono }: { text: string; tone?: Tone; variant?: "soft" | "outline" | "solid"; icon?: LucideIcon; mono?: boolean }) {
  const t = useTheme();
  const color = variant === "solid" ? (tone === "primary" ? t.primaryForeground : t.background) : t[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        alignSelf: "flex-start",
        paddingHorizontal: space(2),
        paddingVertical: 2,
        borderRadius: radius.full,
        borderWidth: variant === "outline" ? 1 : 0,
        borderColor: t.border,
        backgroundColor: variant === "solid" ? t[tone] : variant === "soft" ? (tone === "mutedForeground" ? t.secondary : alpha(t[tone], 0.12)) : "transparent",
      }}
    >
      {Icon && <Icon color={color} size={12} strokeWidth={2} />}
      <RNText maxFontSizeMultiplier={1.3} style={{ color, fontSize: type.label, fontFamily: (mono ? fonts.mono : fonts.sans).medium }}>
        {text}
      </RNText>
    </View>
  );
}

// shadcn's Tabs list: a muted track, the active tab lifted onto the background.
export function Tabs<K extends string>({ value, onChange, items }: { value: K; onChange: (k: K) => void; items: [K, string, (number | string)?][] }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: t.muted, borderRadius: radius.lg, padding: 3 }}>
      {items.map(([k, label, count]) => {
        const on = value === k;
        return (
          <Pressable
            key={k}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={count ? `${label}, ${count}` : label}
            hitSlop={{ top: 3, bottom: 3 }}
            onPress={() => {
              void Haptics.selectionAsync();
              onChange(k);
            }}
            style={{
              flex: 1,
              height: 38,
              flexDirection: "row",
              gap: 6,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.md,
              backgroundColor: on ? (t.dark ? t.input : t.background) : "transparent",
              shadowColor: "#000",
              shadowOpacity: on ? 0.08 : 0,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
            }}
          >
            <RNText maxFontSizeMultiplier={1.3} style={{ color: on ? t.foreground : t.mutedForeground, fontSize: type.sm, fontFamily: fonts.sans.medium }}>
              {label}
            </RNText>
            {!!count && (
              <RNText maxFontSizeMultiplier={1.3} style={{ color: t.mutedForeground, fontSize: type.label, fontFamily: fonts.mono.regular }}>
                {count}
              </RNText>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

// shadcn's Input, with its label and the message under it.
export function Field({ label, hint, error, mono, ...input }: TextInputProps & { label: string; hint?: string; error?: string; mono?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: space(2) }}>
      <Text size={type.sm} weight="medium">
        {label}
      </Text>
      <TextInput
        placeholderTextColor={t.mutedForeground}
        selectionColor={t.primary}
        accessibilityLabel={label}
        {...input}
        style={[
          {
            minHeight: TOUCH,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: error ? t.destructive : t.input,
            backgroundColor: t.dark ? alpha(t.input, 0.3) : "transparent",
            color: t.foreground,
            paddingHorizontal: space(3),
            fontSize: 16,
            fontFamily: (mono ? fonts.mono : fonts.sans).regular,
          },
          input.style,
        ]}
      />
      {error ? (
        <Text size={type.xs} tone="destructive">
          {error}
        </Text>
      ) : hint ? (
        <Text size={type.xs} tone="mutedForeground">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

// ---- surfaces ----

// shadcn's Card: rounded-xl, a hairline border, the card colour, a whisper of shadow.
export function Card({ children, style, onPress, label, accent }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string; accent?: string }) {
  const t = useTheme();
  const base: ViewStyle = {
    backgroundColor: t.card,
    borderColor: accent ?? t.border,
    borderWidth: 1,
    borderRadius: radius.xl,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: t.dark ? 0 : 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [base, pressed && { backgroundColor: t.dark ? t.secondary : t.muted }, style]}>
      {children}
    </Pressable>
  );
}

export function CardHeader({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space(3), paddingHorizontal: space(4), paddingTop: space(4) }}>
      {icon}
      <View style={{ flex: 1, gap: space(1) }}>
        {typeof title === "string" ? (
          <Text size={type.base} weight="semibold">
            {title}
          </Text>
        ) : (
          title
        )}
        {typeof description === "string" ? (
          <Text size={type.sm} tone="mutedForeground">
            {description}
          </Text>
        ) : (
          description
        )}
      </View>
      {action}
    </View>
  );
}

export function CardContent({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ paddingHorizontal: space(4), paddingVertical: space(4), gap: space(2) }, style]}>{children}</View>;
}

// The app's dialog footer: a border on top, a muted wash, the actions.
export function CardFooter({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={{ flexDirection: "row", gap: space(2), paddingHorizontal: space(4), paddingVertical: space(3), borderTopWidth: 1, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.04) }}>{children}</View>;
}

export function Separator({ inset = 0 }: { inset?: number }) {
  const t = useTheme();
  return <View style={{ height: 1, backgroundColor: t.border, marginLeft: inset }} />;
}

// The rail's thin bar (context use, the board's progress).
export function Progress({ value, color, height = 4 }: { value: number; color?: string; height?: number }) {
  const t = useTheme();
  return (
    <View style={{ height, borderRadius: radius.full, backgroundColor: t.muted, overflow: "hidden", flex: 1 }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}>
      <View style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", borderRadius: radius.full, backgroundColor: color ?? t.primary }} />
    </View>
  );
}

// A block of code-shaped text with the app's header strip: an icon, a title, and something on the right.
export function CodeBlock({ icon: Icon, title, right, children, tone = "mutedForeground", lines, accent }: { icon?: LucideIcon; title?: ReactNode; right?: ReactNode; children?: string; tone?: Tone; lines?: number; accent?: string }) {
  const t = useTheme();
  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: accent ?? t.border, backgroundColor: t.card, overflow: "hidden" }}>
      {(title || Icon) && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: 7, borderBottomWidth: children ? 1 : 0, borderColor: t.border, backgroundColor: alpha(t.mutedForeground, 0.06) }}>
          {Icon && <Icon color={t.mutedForeground} size={14} />}
          <View style={{ flex: 1 }}>
            {typeof title === "string" ? (
              <Text mono size={type.xs} lines={1}>
                {title}
              </Text>
            ) : (
              title
            )}
          </View>
          {right}
        </View>
      )}
      {!!children && (
        <Text mono selectable size={type.label} tone={tone} lines={lines} style={{ paddingHorizontal: space(3), paddingVertical: space(2) }}>
          {children}
        </Text>
      )}
    </View>
  );
}

// The app's EmptyState: an icon on a muted tile, a title, a line of help, maybe an action.
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ paddingVertical: space(10), paddingHorizontal: space(6), gap: space(3), alignItems: "center" }}>
      <View style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: t.muted, alignItems: "center", justifyContent: "center" }}>
        <Icon color={t.foreground} size={20} />
      </View>
      <Text size={type.base} weight="medium" center>
        {title}
      </Text>
      {!!description && (
        <Text size={type.sm} tone="mutedForeground" center style={{ maxWidth: 320 }}>
          {description}
        </Text>
      )}
      {action}
    </View>
  );
}

// A tappable row inside a card (settings, lists): 44pt, pressed wash, optional trailing bits.
export function Row({ children, onPress, label, style }: { children: ReactNode; onPress?: () => void; label?: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const base: ViewStyle = { minHeight: TOUCH + 4, paddingHorizontal: space(4), paddingVertical: space(2.5), flexDirection: "row", alignItems: "center", gap: space(3) };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [base, pressed && { backgroundColor: t.accent }, style]}>
      {children}
    </Pressable>
  );
}

// A status line's dot: success when live, muted when not.
export function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}
