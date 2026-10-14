import * as SecureStore from "expo-secure-store";
import type { IdentityStore, PhoneIdentity } from "./remote";

// This phone's identity (its signing key, account and the status keys Macs handed it) lives in the
// iOS Keychain, readable only after the phone is first unlocked.
const KEY = "niti.identity";

export const keychain: IdentityStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as PhoneIdentity;
    } catch {
      return undefined;
    }
  },
  async save(id) {
    if (!id) await SecureStore.deleteItemAsync(KEY);
    else await SecureStore.setItemAsync(KEY, JSON.stringify(id), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  },
};
