import { useHarness } from "./use-harness";
import { EditorView } from "@codemirror/view";
import { answerApproval, send } from "@/lib/actions";
import { useEditor } from "@/store/editor";
import { useApp } from "@/store/app";
import { PAGES, useUI } from "@/store/ui";

// NITI_APP_SMOKE: once the session is live, render every page idle; then run a real goal against
// the fake model — approving each write through the approval dialog — and render every page again
// with a transcript, diffs, a task board and usage on it. Report to main (which also fails the run
// on any console error) and exit.
export const useSmoke = () =>
  useHarness("smoke", async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const tour = async () => {
        for (const p of PAGES) {
          useUI.getState().go(p);
          await wait(700);
        }
        useUI.getState().go("session");
        await wait(300);
      };
      const fail: string[] = [];
      await wait(1000);
      await tour();
      useUI.getState().openPalette();
      await wait(400);
      useUI.getState().closePalette();

      // Both themes: the canvases re-read their colours on a switch.
      const ui = useUI.getState();
      const before = ui.theme;
      for (const t of ["light", "dark"] as const) {
        useUI.getState().setTheme(t);
        for (const p of ["graph", "dashboard", "tokens"] as const) {
          useUI.getState().go(p);
          await wait(450);
        }
      }
      useUI.getState().setTheme(before);
      useUI.getState().go("session");
      await wait(300);

      // A real run: the fake model plans two tasks and writes two files, each behind an approval.
      const sent = await send("build a tiny reddit replica", "team");
      if (!sent) fail.push("the goal was not accepted");
      const t0 = Date.now();
      let approvals = 0;
      let sawDialog = false;
      while (Date.now() - t0 < 45_000) {
        const s = useApp.getState().session;
        if (s.approvals.length) {
          await wait(500); // let the dialog render with the diff before answering
          if (document.querySelector("[role=dialog]")) sawDialog = true;
          approvals++;
          const id = s.approvals[0]!.id;
          if (id === undefined) throw new Error("approval request carries no id");
          await answerApproval(true, undefined, undefined, id);
          await wait(250);
          continue;
        }
        if (s.summary && !s.active) break;
        await wait(250);
      }
      const s = useApp.getState().session;
      if (!s.summary) fail.push("the run never finished");
      if (approvals < 1) fail.push("no approval was requested");
      if (!sawDialog) fail.push("the approval dialog never rendered");
      if (!s.tasks.length) fail.push("no tasks reached the board");
      const diffs = s.order.flatMap((id) => s.agents[id]!.items).filter((i) => i.kind === "diff").length;
      if (!diffs) fail.push("no diff reached a transcript");
      await tour();
      // The graph's Agents view draws the mascots on its canvas.
      try {
        localStorage.setItem("niti.graphMode", "agents");
      } catch {
        /* fine */
      }
      useUI.getState().go("session");
      await wait(200);
      useUI.getState().go("graph");
      await wait(900);
      try {
        localStorage.setItem("niti.graphMode", "project");
      } catch {
        /* fine */
      }
      useUI.getState().go("tasks");
      await wait(500);
      useUI.getState().focusAgent(s.order[0] ?? null);
      useUI.getState().go("session");
      await wait(500);

      // The editor: open a file as a centre tab, edit, save with ⌘S, check the bytes on disk.
      useUI.getState().viewFile("src/b.ts");
      let view: EditorView | null = null;
      for (let i = 0; i < 40 && !view; i++) {
        await wait(150);
        const dom = document.querySelector<HTMLElement>(".cm-editor");
        view = dom ? EditorView.findFromDOM(dom) : null;
      }
      if (!view) fail.push("the editor never opened");
      else {
        view.dispatch({ changes: { from: 0, insert: "// edited in niti\n" } });
        await wait(100);
        if (!useEditor.getState().bufs["src/b.ts"]?.dirty) fail.push("an edit didn't mark the file unsaved");
        view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, ctrlKey: !navigator.userAgent.includes("Mac"), bubbles: true, cancelable: true }));
        await wait(600);
        const disk = await window.niti.readFile("src/b.ts");
        if (!disk.content.startsWith("// edited in niti\n")) fail.push("⌘S didn't write the file");
        if (useEditor.getState().bufs["src/b.ts"]?.dirty) fail.push("the file still reads unsaved after saving");
        // Something else rewrites the file while there are unsaved edits: the banner, then Reload.
        view.dispatch({ changes: { from: 0, insert: "// unsaved\n" } });
        await wait(100);
        await window.niti.writeFile("src/b.ts", "export const b = 42;\n");
        for (let i = 0; i < 30 && !useEditor.getState().bufs["src/b.ts"]?.diskChanged; i++) await wait(200);
        if (!useEditor.getState().bufs["src/b.ts"]?.diskChanged) fail.push("an outside change to an edited file went unnoticed");
        else {
          await useEditor.getState().refresh("src/b.ts");
          await wait(300);
          if (view.state.doc.toString() !== "export const b = 42;\n") fail.push("Reload didn't bring in the outside change");
        }
      }

      const crashed = document.querySelector("[data-crashed]");
      if (crashed) fail.push(`a page crashed: ${crashed.getAttribute("data-crashed")}`);
      await window.niti.smokeReady({
        ok: fail.length === 0,
        detail: fail.length ? fail.join("; ") : `${s.order.length} agents · ${PAGES.length} pages ×2 · ${approvals} approvals · ${s.tasks.length} tasks · ${diffs} diffs · run ${s.summary?.ok ? "ok" : "not ok"}`,
      });
  });
