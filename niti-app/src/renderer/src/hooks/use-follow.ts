import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Follows the bottom while the user is there; once they scroll up it holds still and counts what
// arrived below (the TUI's "scrolled back · N new below · G follows").
export function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const bottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (at !== bottom.current) {
      bottom.current = at;
      setAtBottom(at);
      if (at) setUnseen(0);
    }
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (bottom.current) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + 1);
  }, [dep]);
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    bottom.current = true;
    setAtBottom(true);
    setUnseen(0);
  };
  return { ref, onScroll, atBottom, unseen, jump };
}
