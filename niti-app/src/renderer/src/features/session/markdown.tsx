import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void window.niti.openExternal(href);
      }}
      className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mb-1.5 mt-3 text-[15px] font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1.5 mt-3 text-[14px] font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-2.5 text-[13.5px] font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 marker:text-muted-foreground/60">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60 text-muted-foreground">{children}</thead>,
  th: ({ children }) => <th className="px-2.5 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-t px-2.5 py-1.5 align-top">{children}</td>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-[12px] leading-relaxed scrollbar-thin">{children}</pre>,
  code: ({ className, children }) => {
    const block = /language-/.test(className ?? "") || String(children).includes("\n");
    if (block) return <code className="font-mono">{children}</code>;
    return <code className="rounded-[5px] bg-muted px-1.5 py-[1px] font-mono text-[0.86em] text-primary">{children}</code>;
  },
};

export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  // While a reply streams in, re-parsing the whole growing markdown on every token is the one
  // thing that blocks the main thread. Show it as plain text until it's final, then format once.
  if (streaming)
    return <div className={cn("selectable streaming-caret whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/95 [overflow-wrap:anywhere]", className)}><p>{text}</p></div>;
  return (
    <div className={cn("selectable text-[13.5px] leading-relaxed text-foreground/95 [overflow-wrap:anywhere]", streaming && "streaming-caret", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
