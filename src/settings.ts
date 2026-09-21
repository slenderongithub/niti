// Settings that can change while a session is running. One object, owned by the Engine and shared
// by reference with every Agent, so flipping a field applies to the whole team on its next call —
// the same live-mutation trick as the permission layers (see Engine.setAuto).
export interface RuntimeSettings {
  autoCompact: boolean; // false → never summarize turns to stay under the context window
  thinkingMode: boolean; // false → send no reasoning/thinking parameters to the provider
}

export const defaultSettings = (): RuntimeSettings => ({ autoCompact: true, thinkingMode: true });
