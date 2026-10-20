// Sorts commit subjects into the three groups the TUI's "what's new" counts. This repo's subjects are
// sentences, not conventional commits, so it goes by wording; bump-version.ts writes the result as a
// draft for a person to edit.
export function classify(subjects: string[]): { features: string[]; fixes: string[]; other: string[] } {
  const features: string[] = [], fixes: string[] = [], other: string[] = [];
  for (const s of subjects) {
    if (/^(test|e2e|eval|docs?|repo|refactor|chore|ci)\b|gofmt|^remove\b/i.test(s)) other.push(s);
    else if (/\bfix(es|ed)?\b|\bbug\b|crash|\bno longer\b|didn't|wasn't|\bagain\b|\bkept\b|\bflake\b/i.test(s)) fixes.push(s);
    else features.push(s);
  }
  return { features, fixes, other };
}
