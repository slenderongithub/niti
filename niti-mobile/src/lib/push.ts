import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import type { PushCategory } from "../../../src/remote/protocol.ts";
import { remoteClient } from "./store";

// Pushes come from the relay, sent by the Mac: an approval waiting, a goal that ended, the Mac going
// offline. They carry no code or commands, only what happened and where to look.

Notifications.setNotificationHandler({
  // While the app is open the session screen already shows it; don't stack a banner on top.
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function registerForPush(categories: PushCategory[]): Promise<string | undefined> {
  if (!Device.isDevice) return "push needs a real iPhone";
  const perm = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
  if (!perm.granted) return "notifications are off for niti in Settings";
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    remoteClient()?.setPush(data, categories);
    return undefined;
  } catch (err) {
    return `couldn't register for push: ${err instanceof Error ? err.message : err}`;
  }
}
