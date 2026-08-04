import { LspClient } from "./client.ts";

// Extension → language server, from the `lsp:` block in .niti/agents.yaml:
//
//   lsp:
//     typescript: { command: typescript-language-server, args: [--stdio], extensions: [.ts, .tsx] }
//     go:         { command: gopls, extensions: [.go] }
//
// Servers are user-installed (never bundled) and spawned lazily on first use. One process per
// language is shared by every agent, because diagnostics are a property of the project, not of
// whoever asked for them.
export interface LspServerConfig {
  name: string;
  command: string;
  args?: string[];
  extensions: string[];
}

export class LspRegistry {
  private clients = new Map<string, LspClient>();
  private byExtension = new Map<string, LspServerConfig>();

  constructor(
    servers: LspServerConfig[],
    private root: string = process.cwd(),
  ) {
    for (const s of servers) for (const ext of s.extensions) this.byExtension.set(ext.toLowerCase(), s);
  }

  get configured(): boolean {
    return this.byExtension.size > 0;
  }

  // The client for a file's language, spawning it on first use. undefined = no server configured
  // for this extension, which the tool reports as a plain message rather than an error.
  clientFor(path: string): LspClient | undefined {
    const dot = path.lastIndexOf(".");
    const server = dot < 0 ? undefined : this.byExtension.get(path.slice(dot).toLowerCase());
    if (!server) return undefined;
    let client = this.clients.get(server.name);
    if (!client) {
      client = new LspClient(server.command, server.args ?? [], this.root);
      this.clients.set(server.name, client);
    }
    return client;
  }

  // Every configured server plus whether it has actually been spawned yet — the TUI sidebar shows
  // "configured but idle" differently from "running", which is the difference between a typo in
  // agents.yaml and a language server that simply hasn't been needed yet.
  list(): { name: string; command: string; extensions: string[]; running: boolean }[] {
    const byName = new Map<string, LspServerConfig>();
    for (const s of this.byExtension.values()) byName.set(s.name, s);
    return [...byName.values()].map((s) => ({
      name: s.name,
      command: s.command,
      extensions: s.extensions,
      running: this.clients.has(s.name),
    }));
  }

  close(): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}
