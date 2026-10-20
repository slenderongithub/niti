// Stands in for llama.cpp's llama-server (NITI_LLAMA_SERVER points here in tests): takes the same
// arguments, then serves the scripted fake model (fakellm.ts) on the port it was given, plus the
// /health and /props routes the local runtime polls. No model, no GPU, no download.
const args = process.argv.slice(2);
const port = args[args.indexOf("--port") + 1] ?? "0";
const log = args.includes("--log-file") ? args[args.indexOf("--log-file") + 1]! : "/tmp/fakellama.log";
// The real server answers /health without the key and refuses everything else without it; the
// fake model checks it the same way (NITI_FAKE_API_KEY), so a provider that forgot it fails here too.
if (args.includes("--api-key")) process.env.NITI_FAKE_API_KEY = args[args.indexOf("--api-key") + 1];
// What the runtime launched us with, for tests that check the flags.
await Bun.write(`${log}.args`, JSON.stringify(args));
process.argv = [process.argv[0]!, "fakellm.ts", port, log.slice(0, log.lastIndexOf("/"))];
await import("./fakellm.ts");
