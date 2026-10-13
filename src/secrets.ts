import { basename, isAbsolute, resolve, sep } from "node:path";
import { SECRET_DIRS, SECRET_FILES } from "./sandbox.ts";

// Files whose contents are credentials. An agent's file tools never read one without the user
// approving that exact call (agent.ts force-asks), and grep never scans one — so a key cannot reach
// the model's context, and from there a provider's logs, as a side effect of "search the project".
// Template files (.env.example, …) are not secrets and stay readable.
const SECRET_NAME = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\..+)?|\.netrc|\.pypirc|\.npmrc|\.git-credentials|credentials(\.json)?)$/i;
const TEMPLATE = /\.(example|sample|template|dist|defaults)(\.|$)|\.pub$/i;

export function isSecretPath(p: string, root = process.cwd()): boolean {
  const name = basename(p);
  if (SECRET_NAME.test(name) && !TEMPLATE.test(name)) return true;
  const abs = isAbsolute(p) ? p : resolve(root, p);
  return SECRET_DIRS.some((d) => abs === d || abs.startsWith(d + sep)) || SECRET_FILES.includes(abs); // sep: "\\" on Windows
}

// A shell call naming a secret file anywhere in its arguments (`cat .env`, `cp ~/.ssh/id_rsa x`,
// `--env-file=.env`, `git show HEAD:.env`). The safe-command allowlist auto-approves `cat *`, so
// without this a secret was one unprompted `cat` away.
//
// Or one that reads files it never names: a recursive grep, or rg with its hidden/ignored-file
// filters off (by default rg skips .env and whatever .gitignore lists). Those print matching lines
// of every credential file in the tree; the native `grep` tool skips them, so these ask instead.
export function shellTouchesSecret(command: string, args: string[], root = process.cwd()): boolean {
  const base = basename(command);
  if (base === "grep" && args.some((a) => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|--directories=recurse)$/.test(a))) return true;
  if (base === "rg" && args.some((a) => /^(-[a-zA-Z]*[u.][a-zA-Z]*|--hidden|--no-ignore.*)$/.test(a))) return true;
  return [command, ...args].some((a) => {
    let v = a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    if (base === "git") v = v.slice(v.indexOf(":") + 1); // <rev>:<path>
    return !v.startsWith("-") && v !== "" && isSecretPath(v.replace(/^~(?=\/)/, process.env.HOME ?? "~"), root);
  });
}
