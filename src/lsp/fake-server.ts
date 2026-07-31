// A minimal LSP server used by client.test.ts — enough of the protocol to prove the client's
// framing, request/response pairing, and diagnostics push handling are right, without depending on
// a real language server being installed on the machine running the tests.
//
// Run as: bun src/lsp/fake-server.ts
let buffer = Buffer.alloc(0);

function send(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(msg: { id?: number; method?: string; params?: any }): void {
  switch (msg.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } });
    case "textDocument/didOpen":
    case "textDocument/didChange": {
      const uri = msg.params.textDocument.uri;
      // One error, always at 2:5, so the test can assert exact 1-based conversion.
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } }, severity: 1, message: "type error", source: "fake" }] },
      });
      return;
    }
    case "textDocument/hover":
      return send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: `hover at ${msg.params.position.line}:${msg.params.position.character}` } } });
    case "shutdown":
      return send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString())?.[1] ?? NaN);
    if (!Number.isFinite(length) || buffer.length < split + 4 + length) return;
    const body = buffer.subarray(split + 4, split + 4 + length).toString("utf8");
    buffer = buffer.subarray(split + 4 + length);
    try {
      handle(JSON.parse(body));
    } catch {
      /* ignore malformed input */
    }
  }
});
