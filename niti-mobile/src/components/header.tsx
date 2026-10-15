import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft } from "lucide-react-native";
import { radius, space, TOUCH, type, useTheme } from "@/lib/theme";
import { Text } from "./ui";

// The app's own title bar, in place of the system navigation bar (which iOS now draws as Liquid
// Glass: grey pills that ignore niti's colours, with icons that can vanish into them). Like the
// desktop's title bar: the background colour, a hairline under it, a quiet back button, the title in
// the middle, and labelled actions on the right.
export function Header({ title, back, left, right }: { title?: string; back?: string; left?: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: t.background, borderBottomWidth: 1, borderColor: t.border }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: space(2), gap: space(2) }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
          {back !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Back to ${back}`}
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/macs"))} // opened from a notification: nothing behind it
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 2,
                minHeight: TOUCH,
                paddingLeft: space(1),
                paddingRight: space(2.5),
                borderRadius: radius.md,
                backgroundColor: pressed ? t.accent : "transparent",
                maxWidth: 150,
              })}
            >
              <ChevronLeft color={t.foreground} size={20} />
              <Text size={type.sm} tone="mutedForeground" lines={1}>
                {back}
              </Text>
            </Pressable>
          ) : (
            <View style={{ paddingLeft: space(2) }}>{left}</View>
          )}
        </View>
        {!!title && (
          <Text size={type.base} weight="semibold" lines={1} style={{ maxWidth: "50%" }}>
            {title}
          </Text>
        )}
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space(2), paddingRight: space(1) }}>{right}</View>
      </View>
    </View>
  );
}
