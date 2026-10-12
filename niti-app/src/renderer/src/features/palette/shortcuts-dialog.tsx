import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useUI } from "@/store/ui";

const GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: "Everywhere",
    items: [
      ["Command palette", ["⌘", "K"]],
      ["Session · Tasks · Tokens · Graph · Dashboard", ["⌘", "1–5"]],
      ["Settings", ["⌘", ","]],
      ["Switch a model", ["⌘", "L"]],
      ["Prompt history", ["⌘", "R"]],
      ["Focus agent N", ["⌥", "1–9"]],
      ["Toggle sidebar", ["⌘", "B"]],
      ["Focus mode", ["⌘", "."]],
      ["Open folder", ["⌘", "O"]],
      ["New window", ["⇧", "⌘", "N"]],
    ],
  },
  {
    title: "Composer",
    items: [
      ["Send to the team", ["⏎"]],
      ["New line", ["⇧", "⏎"]],
      ["Build ⇄ Plan", ["⇧", "⇥"]],
      ["Use the suggestion", ["⇥"]],
      ["Stop the run", ["esc"]],
      ["Browse history", ["↑", "↓"]],
      ["Command · file · shell", ["/", "@", "!"]],
    ],
  },
  {
    title: "Approvals",
    items: [
      ["Allow", ["Y"]],
      ["Always for this agent", ["A"]],
      ["Deny", ["N"]],
      ["Edit before allowing", ["E"]],
      ["Deny and tell", ["T"]],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useUI((s) => s.shortcutsOpen);
  const set = useUI((s) => s.setShortcuts);
  return (
    <Dialog open={open} onOpenChange={set}>
      <DialogContent className="w-[min(760px,94vw)] max-w-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">Keyboard shortcuts</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title} className={g.title === "Everywhere" ? "md:row-span-2" : ""}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</div>
              <div className="space-y-1.5">
                {g.items.map(([label, keys]) => (
                  <div key={label} className="flex items-center justify-between gap-4 text-[13px]">
                    <span>{label}</span>
                    <KbdGroup>
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
