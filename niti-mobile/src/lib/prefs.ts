import AsyncStorage from "@react-native-async-storage/async-storage";
import { PUSH_CATEGORIES, type PushCategory } from "../../../src/remote/protocol.ts";

// What this phone wants pushed. Every kind is on until turned off in Settings.
export interface Prefs {
  push: PushCategory[];
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await AsyncStorage.getItem("niti.prefs");
    if (raw) return JSON.parse(raw) as Prefs;
  } catch {
    /* defaults */
  }
  return { push: [...PUSH_CATEGORIES] };
}

export const savePrefs = (p: Prefs) => AsyncStorage.setItem("niti.prefs", JSON.stringify(p));
