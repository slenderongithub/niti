import { basename, isAbsolute, resolve } from "node:path";
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
  return SECRET_DIRS.some((d) => abs === d || abs.startsWith(d + "/")) || SECRET_FILES.includes(abs);
}

// A shell call naming a secret file anywhere in its arguments (`cat .env`, `cp ~/.ssh/id_rsa x`,
// `--env-file=.env`). The safe-command allowlist auto-approves `cat *`, so without this a secret
// was one unprompted `cat` away.
export function shellTouchesSecret(command: string, args: string[], root = process.cwd()): boolean {
  return [command, ...args].some((a) => {
    const v = a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    return !v.startsWith("-") && v !== "" && isSecretPath(v.replace(/^~(?=\/)/, process.env.HOME ?? "~"), root);
  });
}
