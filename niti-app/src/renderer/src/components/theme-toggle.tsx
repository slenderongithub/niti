import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUI } from "@/store/ui";
import type { ThemeSource } from "../../../shared/bridge";

export function ThemeToggle({ side = "bottom" }: { side?: "top" | "bottom" | "right" }) {
  const theme = useUI((s) => s.theme);
  const dark = useUI((s) => s.resolvedDark);
  const setTheme = useUI((s) => s.setTheme);
  const Icon = theme === "system" ? Monitor : dark ? Moon : Sun;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme">
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side={side} className="w-40">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeSource)}>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
