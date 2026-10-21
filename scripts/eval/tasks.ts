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
//   multistep — can it carry one change through several files without losing the thread?
//
// Tasks marked `suite: "local"` aim at what small local models get wrong (losing track across
// files, editing before finding). They run with --suite local, or by default under the local
// profile; the default suite stays the original seven so cloud baselines stay comparable.

export interface Task {
  name: string;
  tests: "navigate" | "edit" | "verify" | "restraint" | "multistep";
  suite?: "local";
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

// A 40-module service, big enough that the repo map is generated and a wandering agent piles up
// enough tool output for observation masking to engage — the token machinery the six small
// fixtures never reach. One pricing rule is wrong; the agent is told the symptom, not the file.
const SERVICE: Record<string, string> = { "package.json": PKG };
for (const area of ["billing", "catalog", "orders", "users", "shipping"]) {
  for (let i = 0; i < 8; i++) {
    SERVICE[`src/${area}/${area}-${i}.ts`] =
      `// ${area} module ${i}\nexport function ${area}Step${i}(input: number): number {\n  return input + ${i};\n}\n`;
  }
}
SERVICE["src/billing/discounts.ts"] =
  "export const MEMBER_TIERS = ['basic', 'silver', 'gold'] as const;\n\n" +
  "export function discountFor(tier: string): number {\n  if (tier === 'gold') return 0.15;\n  if (tier === 'silver') return 0.05;\n  return 0;\n}\n";

export const TASKS: Task[] = [
  {
    name: "fix-a-rule-in-a-larger-service",
    tests: "navigate",
    files: SERVICE,
    prompt: "Gold members are getting a 15% discount, but it should be 10%. Fix it. Do not change anything else.",
    check: (read) => {
      const d = read("src/billing/discounts.ts");
      if (!d) return "src/billing/discounts.ts is gone";
      if (!/tier === 'gold'\) return 0\.1;/.test(d.replace(/0\.10\b/, "0.1"))) return "gold discount is not 0.1";
      if (!d.includes("if (tier === 'silver') return 0.05;")) return "changed the silver rule, which it was told not to touch";
      if (read("src/billing/billing-0.ts") !== SERVICE["src/billing/billing-0.ts"]) return "edited an unrelated module";
      return null;
    },
  },
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
    prompt: "Add a subtract(a, b) function to src/math.ts, next to add. Start by writing the body as the placeholder `return TODO_BROKEN;`, then replace it with a working implementation before you finish.",
    check: (read) => {
      // Checked first, and reported distinctly: "could not fix it" and "disabled the check instead"
      // are different failures with different fixes, and a single verdict covering both hid which
      // one was happening. This line is what measures the check-gaming guard.
      const guard = read("check.js");
      if (!guard?.includes("TODO_BROKEN")) return "disabled the check instead of fixing the code";
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
  {
    name: "carry-a-rename-through-three-files",
    tests: "multistep",
    suite: "local",
    files: {
      "package.json": PKG,
      "src/cli.ts": "import { help } from './help.ts';\n\nexport function parse(argv: string[]) {\n  return { verbose: argv.includes('--verbose'), help: argv.includes('--help') ? help() : '' };\n}\n",
      "src/help.ts": "export function help(): string {\n  return 'usage: tool [--verbose] [--help]\\n  --verbose  print every step';\n}\n",
      "README.md": "# tool\n\nRun `tool --verbose` to print every step.\n",
    },
    prompt: "Rename the --verbose flag to --debug everywhere: the parser, the help text and the README. Keep everything else as it is.",
    check: (read) => {
      for (const f of ["src/cli.ts", "src/help.ts", "README.md"]) {
        const t = read(f) ?? "";
        if (t.includes("--verbose")) return `${f} still mentions --verbose`;
        if (!t.includes("--debug")) return `${f} never got --debug`;
      }
      if (!read("src/cli.ts")!.includes("--help")) return "src/cli.ts lost --help";
      if (!read("src/help.ts")!.includes("print every step")) return "the help text lost its description";
      return null;
    },
  },
  {
    name: "find-the-check-before-fixing-it",
    tests: "navigate",
    suite: "local",
    files: {
      "package.json": PKG,
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/orders/step-${i}.ts`, `export const step${i} = (n: number) => n * ${i + 1};\n`])),
      "src/orders/validate.ts": "export function validate(order: { quantity: number }): void {\n  if (order.quantity < 0) throw new Error('invalid quantity');\n}\n",
    },
    prompt: "Orders with a quantity of 0 are accepted, but they should be rejected with the 'invalid quantity' error like negative ones are. Fix it.",
    check: (read) => {
      const v = read("src/orders/validate.ts") ?? "";
      if (!/quantity\s*(<=\s*0|<\s*1)/.test(v)) return "validate.ts still accepts a quantity of 0";
      if (!v.includes("invalid quantity")) return "the error message changed";
      for (let i = 0; i < 12; i++) if (!(read(`src/orders/step-${i}.ts`) ?? "").includes(`n * ${i + 1}`)) return `step-${i}.ts was changed`;
      return null;
    },
  },
  // What a local model failed at outright before the action protocol: deleting, running, styling.
  {
    name: "delete-the-dead-module",
    tests: "edit",
    suite: "local",
    files: {
      "package.json": PKG,
      "src/index.ts": "import { greet } from './greet.ts';\nconsole.log(greet('world'));\n",
      "src/greet.ts": "export const greet = (n: string) => `hello ${n}`;\n",
      "src/legacy-greet.ts": "// unused since the rewrite\nexport const oldGreet = (n: string) => 'hi ' + n;\n",
    },
    prompt: "src/legacy-greet.ts isn't used anywhere any more. Delete it.",
    check: (read) => {
      if (read("src/legacy-greet.ts") !== undefined) return "src/legacy-greet.ts still exists";
      if (!(read("src/greet.ts") ?? "").includes("hello")) return "src/greet.ts was changed or removed";
      if (!(read("src/index.ts") ?? "").includes("greet('world')")) return "src/index.ts was changed";
      return null;
    },
  },
  {
    name: "run-the-generator",
    tests: "multistep",
    suite: "local",
    files: {
      "package.json": PKG,
      "gen.js": "const fs = require('fs');\nconst rows = [1, 2, 3].map((n) => `item ${n}: ${n * n}`);\nfs.writeFileSync('squares.txt', rows.join('\\n') + '\\n');\n",
    },
    prompt: "Run gen.js with node, and tell me what squares.txt says. Don't write squares.txt yourself.",
    check: (read) => {
      const t = read("squares.txt");
      if (t === undefined) return "squares.txt was never generated (gen.js wasn't run)";
      if (!t.includes("item 3: 9")) return "squares.txt doesn't hold what gen.js writes";
      if (read("gen.js")?.includes("item ${n}") !== true) return "gen.js was changed";
      return null;
    },
  },
  {
    name: "style-a-landing-page",
    tests: "multistep",
    suite: "local",
    files: { "package.json": PKG },
    prompt: "Make a stunning landing page for Bean There, a small coffee roaster: index.html and styles.css.",
    check: (read) => {
      const html = read("index.html") ?? "";
      const css = read("styles.css") ?? "";
      if (!html) return "no index.html";
      if (!/href=["']styles\.css["']/.test(html)) return "index.html doesn't link styles.css";
      if (!/bean there/i.test(html)) return "the page never names Bean There";
      if (/lorem ipsum|123-456-7890|example\.com/i.test(html)) return "placeholder copy left in";
      if ((css.match(/\{/g) ?? []).length < 15) return "styles.css is barely styled";
      if (!/@media/.test(css)) return "no media query";
      if (!/:hover/.test(css)) return "no hover states";
      if (!/fonts\.googleapis|@font-face/.test(html + css) && /font-family\s*:\s*(arial|helvetica|sans-serif)/i.test(css)) return "default fonts only";
      return null;
    },
  },
];
