// The benchmark the harness is tuned against. Every task is small enough to run on a cheap model
// in under a minute and specific enough that its check cannot be satisfied by a plausible-looking
// answer — which is the whole point. A harness change that "feels better" and moves nothing here
// did nothing; a change that moves this is real regardless of how it felt.
//
// Each task exercises one thing the harness is supposed to make possible:
//   navigate  — can the agent find code it was not told the location of?
//   edit      — can it change existing code without clobbering it?
//   verify    — does it notice and fix its own broken output?
//   restraint — does it leave alone what it was not asked to touch?

export interface Task {
  name: string;
  tests: "navigate" | "edit" | "verify" | "restraint";
  files: Record<string, string>;
  prompt: string;
  // Returns null when the task passed, or a one-line reason it failed. `read` is project-relative
  // and returns undefined for a file that does not exist.
  check: (read: (path: string) => string | undefined) => string | null;
}

// No `scripts` block: detectChecks then finds nothing and these fixtures run without a
// verification pass, which is what they are meant to measure. A `typecheck: tsc --noEmit` here
// would resolve to whatever tsc happens to be installed on the machine running the eval, making
// the score depend on the runner rather than on the harness. Only the `verify` task ships a
// check, and it ships a hermetic one.
const PKG = JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2);

export const TASKS: Task[] = [
  {
    name: "find-and-change-a-constant",
    tests: "navigate",
    // The agent is never told where the timeout lives. Without search it has to read its way
    // through the tree or guess — which is exactly the harness gap being measured.
    files: {
      "package.json": PKG,
      "src/index.ts": "import { fetchUser } from './net/client.ts';\nexport const main = () => fetchUser('1');\n",
      "src/net/client.ts": "const REQUEST_TIMEOUT_MS = 3000;\n\nexport async function fetchUser(id: string) {\n  return { id, timeout: REQUEST_TIMEOUT_MS };\n}\n",
      "src/net/retry.ts": "export const MAX_RETRIES = 3;\n",
      "README.md": "# fixture\nA small client.\n",
    },
    prompt: "The request timeout is too short. Change it to 10000 milliseconds. Do not change anything else.",
    check: (read) => {
      const client = read("src/net/client.ts");
      if (!client) return "src/net/client.ts is gone";
      if (!/REQUEST_TIMEOUT_MS\s*=\s*10000/.test(client)) return "timeout was not changed to 10000";
      if (!client.includes("export async function fetchUser")) return "fetchUser was destroyed";
      if (read("src/net/retry.ts") !== "export const MAX_RETRIES = 3;\n") return "changed retry.ts, which it was told not to touch";
      return null;
    },
  },
  {
    name: "rename-a-symbol-everywhere",
    tests: "navigate",
    // Three files, one of which is easy to miss. A grep answers this in one call.
    files: {
      "package.json": PKG,
      "src/cart.ts": "export function calcTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
      "src/checkout.ts": "import { calcTotal } from './cart.ts';\nexport const pay = (items: number[]) => calcTotal(items);\n",
      "src/report.ts": "import { calcTotal } from './cart.ts';\nexport const summary = (items: number[]) => `total: ${calcTotal(items)}`;\n",
    },
    prompt: "Rename the function calcTotal to computeTotal everywhere it is used.",
    check: (read) => {
      for (const f of ["src/cart.ts", "src/checkout.ts", "src/report.ts"]) {
        const body = read(f);
        if (!body) return `${f} is gone`;
        if (body.includes("calcTotal")) return `${f} still refers to calcTotal`;
        if (!body.includes("computeTotal")) return `${f} never got computeTotal`;
      }
      return null;
    },
  },
  {
    name: "edit-without-clobbering",
    tests: "edit",
    // A long file with one line to change. A model that reaches for write_file instead of edit
    // rewrites it from memory and silently drops the rest.
    files: {
      "package.json": PKG,
      "src/config.ts":
        "// Generated — do not reformat.\n" +
        Array.from({ length: 40 }, (_, i) => `export const SETTING_${i} = ${i};`).join("\n") +
        "\nexport const FEATURE_FLAG = false;\n" +
        Array.from({ length: 40 }, (_, i) => `export const EXTRA_${i} = "${i}";`).join("\n") +
        "\n",
    },
    prompt: "Turn FEATURE_FLAG on in src/config.ts.",
    check: (read) => {
      const body = read("src/config.ts");
      if (!body) return "src/config.ts is gone";
      if (!/FEATURE_FLAG\s*=\s*true/.test(body)) return "FEATURE_FLAG was not turned on";
      if (!body.includes("SETTING_39")) return "the rest of the file was clobbered";
      if (!body.includes("EXTRA_39")) return "the tail of the file was clobbered";
      return null;
    },
  },
  {
    name: "fix-what-it-broke",
    tests: "verify",
    // The file does not compile. Nothing in the prompt says so — the verification pass is what
    // is supposed to tell the agent, and this task fails outright without it.
    files: {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { typecheck: "node check.js" } }, null, 2),
      // A check with no toolchain to install: the "type error" is a marker string.
      "check.js":
        "const fs = require('fs');\n" +
        "const src = fs.readFileSync('src/math.ts', 'utf8');\n" +
        "if (src.includes('TODO_BROKEN')) { console.error('src/math.ts:3 - error: TODO_BROKEN is not defined'); process.exit(1); }\n" +
        "if (!/export function add/.test(src)) { console.error('src/math.ts - error: add() was removed'); process.exit(1); }\n",
      "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    },
    prompt: "Add a subtract(a, b) function to src/math.ts, next to add. Write the body as `return TODO_BROKEN;` for now.",
    check: (read) => {
      const body = read("src/math.ts");
      if (!body) return "src/math.ts is gone";
      if (body.includes("TODO_BROKEN")) return "left the project failing its own check";
      if (!/subtract/.test(body)) return "subtract was never added";
      if (!/export function add/.test(body)) return "add() was removed to make the check pass";
      return null;
    },
  },
  {
    name: "answer-without-touching-anything",
    tests: "restraint",
    files: {
      "package.json": PKG,
      "src/auth.ts": "export function login(user: string, token: string) {\n  return { user, token, at: Date.now() };\n}\n",
      "src/db.ts": "export const connect = () => ({ ok: true });\n",
    },
    prompt: "Which file defines login, and what does it return? Answer only — change nothing.",
    check: (read) => {
      if (read("src/auth.ts") !== "export function login(user: string, token: string) {\n  return { user, token, at: Date.now() };\n}\n") {
        return "modified src/auth.ts when asked only to answer";
      }
      if (read("src/db.ts") !== "export const connect = () => ({ ok: true });\n") return "modified src/db.ts";
      return null;
    },
  },
  {
    name: "add-a-file-in-the-right-place",
    tests: "navigate",
    files: {
      "package.json": PKG,
      "src/routes/users.ts": "export const users = () => ['a'];\n",
      "src/routes/posts.ts": "export const posts = () => ['b'];\n",
      "src/routes/index.ts": "export { users } from './users.ts';\nexport { posts } from './posts.ts';\n",
    },
    prompt: "Add a comments route that works the same way as the others, and make sure it is exported alongside them.",
    check: (read) => {
      const file = read("src/routes/comments.ts");
      if (!file) return "src/routes/comments.ts was not created";
      if (!/export const comments/.test(file)) return "comments.ts does not follow the existing shape";
      const index = read("src/routes/index.ts");
      if (!index?.includes("comments")) return "the new route was never exported from index.ts";
      if (!index.includes("users") || !index.includes("posts")) return "index.ts lost its existing exports";
      return null;
    },
  },
];
