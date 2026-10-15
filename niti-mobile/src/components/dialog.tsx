import { useEffect, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, View } from "react-native";
import { radius, space, type, useReduceMotion, useTheme } from "@/lib/theme";
import { Button, Text } from "./ui";

// The app's own alert, in place of iOS's: Alert.alert and action sheets are Liquid Glass now, which
// ignores niti's colours. This is the desktop's AlertDialog (components/ui/alert-dialog.tsx): a card
// on the background colour over a dimmed screen, the title, the description, and the actions stacked
// full width as shadcn stacks them on a narrow screen, cancel last. Same call shape as Alert.alert.
export type DialogAction = { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
type Request = { title: string; message?: string; actions: DialogAction[] };

let show: ((r: Request) => void) | undefined;

export function alert(title: string, message?: string, actions: DialogAction[] = [{ text: "OK" }]): void {
  if (show) show({ title, message, actions });
  else Alert.alert(title, message, actions); // before the app has drawn its root: nothing to draw on yet
}

// Mounted once at the root. A Modal, so it also shows over the Settings and Approval screens.
export function DialogHost() {
  const t = useTheme();
  const reduce = useReduceMotion();
  const [req, setReq] = useState<Request>();
  const after = useRef<() => void>(undefined);
  useEffect(() => {
    show = setReq;
    return () => void (show = undefined);
  }, []);

  // The chosen action runs once the dialog is gone, so an action that opens another dialog (the
  // Actions menu's Status, say) doesn't race this one closing.
  const choose = (a?: DialogAction) => {
    after.current = a?.onPress;
    setReq(undefined);
    if (Platform.OS !== "ios") done(); // onDismiss is iOS only
  };
  const done = () => {
    const fn = after.current;
    after.current = undefined;
    fn?.();
  };

  const actions = req?.actions ?? [];
  const cancel = actions.find((a) => a.style === "cancel");
  const rest = actions.filter((a) => a !== cancel);
  return (
    <Modal transparent visible={!!req} animationType={reduce ? "none" : "fade"} onRequestClose={() => choose(cancel)} onDismiss={done} statusBarTranslucent>
      {/* The desktop's overlay is bg-black/50 in both themes. */}
      <Pressable accessibilityLabel="Close" onPress={() => cancel && choose(cancel)} style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)", justifyContent: "center", padding: space(4) }}>
        <Pressable
          accessibilityViewIsModal
          onPress={() => {}} // a tap on the card isn't a tap on the backdrop
          style={{ alignSelf: "center", width: "100%", maxWidth: 420, gap: space(4), padding: space(5), borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.background }}
        >
          <View style={{ gap: space(1.5) }}>
            <Text size={type.lg} weight="semibold" accessibilityRole="header">
              {req?.title ?? ""}
            </Text>
            {!!req?.message && (
              <Text size={type.sm} tone="mutedForeground">
                {req.message}
              </Text>
            )}
          </View>
          <View style={{ gap: space(2) }}>
            {rest.map((a) => (
              <Button key={a.text} title={a.text} variant={a.style === "destructive" ? "destructive" : rest.length === 1 ? "default" : "secondary"} onPress={() => choose(a)} />
            ))}
            {cancel && <Button title={cancel.text} variant="outline" onPress={() => choose(cancel)} />}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
