import type { NitiBridge } from "../shared/bridge";

declare global {
  interface Window {
    niti: NitiBridge;
  }
}

export {};
