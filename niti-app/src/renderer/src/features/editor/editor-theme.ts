import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// The editor in the app's own tokens, so it follows light/dark without a second theme. Syntax
// colours echo the TUI's (keyword alt, string amber, number blue, comment muted italic).
export const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace', lineHeight: "1.65" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--primary)" },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent) !important" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in oklab, var(--primary) 28%, transparent) !important" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--background)", color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 16px", minWidth: "44px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "var(--muted-foreground)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)", outline: "1px solid color-mix(in oklab, var(--primary) 45%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warning) 28%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--primary) 35%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "inherit", fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--background)", border: "1px solid var(--input)", borderRadius: "6px", color: "var(--foreground)", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--secondary)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--foreground)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "8px", color: "var(--popover-foreground)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
  ".cm-changed-gutter": { width: "3px", padding: "0 !important", marginRight: "2px" },
  ".cm-changed-marker": { width: "3px", height: "100%", backgroundColor: "var(--success)", borderRadius: "1px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--muted)", border: "none", color: "var(--muted-foreground)" },
});

export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--primary)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--agent-4)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--agent-5)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--agent-1)" },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--agent-3)" },
    { tag: [t.tagName], color: "var(--agent-2)" },
    { tag: [t.attributeName], color: "var(--agent-4)" },
    { tag: [t.definition(t.variableName)], color: "var(--foreground)" },
    { tag: [t.heading], fontWeight: "600", color: "var(--foreground)" },
    { tag: [t.link, t.url], color: "var(--primary)", textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "600" },
    { tag: [t.invalid], color: "var(--destructive)" },
    { tag: [t.punctuation, t.operator], color: "color-mix(in oklab, var(--foreground) 70%, var(--muted-foreground))" },
  ]),
);
