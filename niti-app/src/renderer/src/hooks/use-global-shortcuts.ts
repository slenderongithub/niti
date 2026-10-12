import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useUI, type Page } from "@/store/ui";

// Menu accelerators arrive from main (so they work even while a text field has focus); the few
// shortcuts without a menu item are handled here.
export function useGlobalShortcuts() {
  useEffect(() => {
    const offMenu = window.niti.onMenu((cmd) => {
      const app = useApp.getState();
      const ui = useUI.getState();
      if (cmd === "open-folder") {
        void window.niti.pickFolder().then((p) => { if (p) void app.openProject(p); });
        return;
      }
      if (cmd === "close-project") {
        if (app.phase !== "launch") void app.closeProject();
        return;
      }
      if (app.phase !== "session") return;
      if (cmd.startsWith("page:")) ui.go(cmd.slice(5) as Page);
      else if (cmd === "settings") ui.go("settings");
      else if (cmd === "palette") (ui.paletteOpen ? ui.closePalette() : ui.openPalette());
      else if (cmd === "toggle-sidebar") ui.toggleSidebar();
      else if (cmd === "focus-mode") ui.toggleFocusMode();
      else if (cmd === "shortcuts") ui.setShortcuts(!ui.shortcutsOpen);
    });
    const offOpen = window.niti.onOpenProject((root) => void useApp.getState().openProject(root));

    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState();
      if (app.phase !== "session") return;
      const ui = useUI.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        ui.setModelPicker(true);
      } else if (mod && e.key.toLowerCase() === "r" && !e.shiftKey) {
        e.preventDefault();
        ui.openPalette("history: ");
      } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const id = app.session.order[Number(e.code.slice(5)) - 1];
        if (id) {
          e.preventDefault();
          ui.go("session");
          ui.focusAgent(ui.focusedAgent === id ? null : id);
        }
      } else if (e.key === "F1") {
        e.preventDefault();
        ui.setShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offMenu();
      offOpen();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
