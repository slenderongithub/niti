// A throwaway project wired to the repo's fake model (scripts/e2e/fakellm.ts): what the smoke and
// live checks run the app and its client against. No network, no cost.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "../..");

export interface Fixture {
  project: string;
  state: string;
  llmPort: number;
  env: Record<string, string>;
  stop(): void;
}

export async function fixture(opts: { agents?: string[]; chunked?: boolean } = {}): Promise<Fixture> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "niti-app-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "niti-app-state-")));
  const llmPort = 48600 + Math.floor(Math.random() * 800);
  // With `chunked`, agents talk to scripts/chunkllm.ts, which streams the fake model's text in
  // small deltas the way a real provider does.
  const agentPort = opts.chunked ? llmPort + 1000 : llmPort;
  mkdirSync(join(project, "src"));
  mkdirSync(join(project, ".niti"));
  writeFileSync(join(project, "src/a.ts"), 'import { b } from "./b";\nexport const a = b + 1;\n');
  writeFileSync(join(project, "src/b.ts"), "export const b = 1;\n");
  writeFileSync(join(project, "README.md"), "# fixture\n");
  const tools = ["read_file", "write_file", "edit", "shell", "list_dir", "grep", "glob"];
  const ids = opts.agents ?? ["backend", "frontend"];
  writeFileSync(
    join(project, ".niti/agents.yaml"),
    `agents:\n` +
      ids
        .map((id, i) => `  - id: ${id}\n    provider: custom\n    model: fake\n    role: ${id}\n    baseURL: http://127.0.0.1:${agentPort}/v1\n    systemPrompt: You build ${id}.\n${i === 0 ? "    lead: true\n" : ""}    allowedTools: [${tools.join(", ")}]`)
        .join("\n") +
      "\nverify: false\n",
  );
  // A git repo, so /graph and /files take the same path they do in a real project.
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  Bun.spawnSync(["git", "add", "-A"], { cwd: project });
  const llm = Bun.spawn(["bun", join(REPO, "scripts/e2e/fakellm.ts"), String(llmPort), state], { stdout: "ignore", stderr: "ignore" });
  const proxy = opts.chunked ? Bun.spawn(["bun", join(import.meta.dir, "chunkllm.ts"), String(agentPort), String(llmPort)], { stdout: "ignore", stderr: "inherit" }) : undefined;
  // Wait for the fake model to listen.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${agentPort}/v1/models`);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const env: Record<string, string> = {
    NITI_AUTH_FILE: join(state, "auth.json"),
    NITI_TRUST_FILE: join(state, "trust.json"),
    // The core refreshes model lists from models.dev; the checks stay offline, like scripts/e2e.
    NITI_OFFLINE: "1",
    NITI_MODELS_FILE: join(state, "models.json"),
  };
  return {
    project,
    state,
    llmPort,
    env,
    stop: () => {
      llm.kill();
      proxy?.kill();
    },
  };
}
