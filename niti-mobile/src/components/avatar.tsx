import { memo } from "react";
import { Image, Text as RNText, View, type ImageSourcePropType } from "react-native";
import { Asset } from "expo-asset";
import { useTick } from "@/lib/ticker";
import { fonts, useTheme } from "@/lib/theme";

// The desktop app's agent avatars (niti-app/src/renderer/src/assets/avatars, made by
// scripts/avatars/make-avatars.py): one character per roster slot, an open frame and a blink frame.
// Avatar 4 laughs with its eyes shut, so it has no blink.
export const AVATAR_IMAGES: number[] = []; // every frame, for preloading at launch (_layout.tsx)

const OPEN = [
  require("../../../niti-app/src/renderer/src/assets/avatars/niti1.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti2.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti3.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti4.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti5.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti6.png"),
];
const BLINK = [
  require("../../../niti-app/src/renderer/src/assets/avatars/niti1-blink.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti2-blink.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti3-blink.png"),
  null,
  require("../../../niti-app/src/renderer/src/assets/avatars/niti5-blink.png"),
  require("../../../niti-app/src/renderer/src/assets/avatars/niti6-blink.png"),
];

AVATAR_IMAGES.push(...OPEN, ...BLINK.filter((b): b is number => b !== null));

// The file preloading saved on the phone, once there is one: a dev server's images otherwise come
// over the network again whenever an avatar mounts.
const src = (mod: number): ImageSourcePropType => {
  const local = Asset.fromModule(mod).localUri;
  return local ? { uri: local } : mod;
};

// The blink rhythm of niti-app/src/renderer/src/lib/avatars.ts: a 5.2s cycle, offset per slot so a
// team never blinks in unison. (That file imports the images through the app's own alias, so the
// three numbers are repeated here; keep them in step.)
const BLINK_PERIOD = 5200;
const BLINK_LENGTH = 160;
const slotOf = (slot: number) => ((slot % 6) + 6) % 6;
const blinking = (slot: number, ms: number) => (ms + ((slotOf(slot) * 1700) % BLINK_PERIOD)) % BLINK_PERIOD < BLINK_LENGTH;

export const PixelAvatar = memo(function PixelAvatar({ slot, size = 28, working }: { slot: number; size?: number; working?: boolean }) {
  const tick = useTick();
  const i = slotOf(slot);
  const shut = BLINK[i] && blinking(slot, tick * 100);
  const bob = working && Math.floor(tick / 4.5) % 2 === 1; // the desktop's 0.9s, two-step bob
  // Both frames stay mounted and the blink one fades in over the open one, as on the desktop:
  // swapping the image's source made it load (and flash) again on every blink.
  return (
    <View style={{ width: size, height: size, transform: [{ translateY: bob ? -1 : 0 }] }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image source={src(OPEN[i])} style={{ width: size, height: size }} fadeDuration={0} />
      {BLINK[i] && <Image source={src(BLINK[i])} style={{ position: "absolute", width: size, height: size, opacity: shut ? 1 : 0 }} fadeDuration={0} />}
    </View>
  );
});

type Status = "idle" | "working" | "done" | "failed" | string;

// An agent's identity mark: its avatar, the lead's ★ on the corner, and a status dot.
export function AgentAvatar({ slot, lead, status, size = 32 }: { slot: number; lead?: boolean; status?: Status; size?: number }) {
  const t = useTheme();
  const dot = status === "working" ? t.info : status === "failed" ? t.destructive : status && status !== "idle" ? t.success : undefined;
  return (
    <View style={{ width: size, height: size }}>
      <PixelAvatar slot={slot} size={size} working={status === "working"} />
      {lead && (
        <View
          style={{
            position: "absolute",
            right: -4,
            top: -4,
            width: 15,
            height: 15,
            borderRadius: 8,
            backgroundColor: t.background,
            borderWidth: 1,
            borderColor: t.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <RNText style={{ color: t.warning, fontSize: 9, lineHeight: 11, fontFamily: fonts.sans.regular }}>★</RNText>
        </View>
      )}
      {dot && <View style={{ position: "absolute", right: -2, bottom: -2, width: 10, height: 10, borderRadius: 5, backgroundColor: dot, borderWidth: 2, borderColor: t.background }} />}
    </View>
  );
}
