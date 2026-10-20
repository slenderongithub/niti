// Stands in for niti's MLX engine (NITI_MLX_SERVER points here in tests): takes the wrapper's
// arguments (--model <dir> --port N …) and its key from NITI_MLX_KEY, then serves the scripted fake
// model (fakellm.ts) with /health. No Python, no MLX, no GPU.
const args = process.argv.slice(2);
const port = args[args.indexOf("--port") + 1] ?? "0";
const model = args[args.indexOf("--model") + 1] ?? "";
if (process.env.NITI_MLX_KEY) process.env.NITI_FAKE_API_KEY = process.env.NITI_MLX_KEY;
await Bun.write(`${model}/.fakemlx-args`, JSON.stringify(args));
// A model from the fake zoo (fakezoo.ts) answers as its persona: a folder named zoo/<persona>-MLX-4bit.
const zoo = /zoo(?:\/|__)([a-z0-9]+)-MLX/i.exec(model);
if (zoo) process.env.NITI_FAKE_PERSONA = zoo[1];
process.argv = [process.argv[0]!, "fakellm.ts", port, model];
await import("./fakellm.ts");
