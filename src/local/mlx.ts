// The MLX engine: Apple's mlx-lm server, for models published in MLX format (safetensors, Apple
// Silicon only). It is Python, so unlike llama-server it isn't bundled: the first MLX model a person
// downloads or adds fetches it — a standalone CPython (python-build-standalone, pinned by checksum)
// and mlx-lm with everything it needs, installed by pip with --require-hashes against the lock in
// mlx-lock.ts, so nothing that isn't byte-for-byte what was reviewed can be installed. About 140 MB to
// download, about 520 MB on disk, once per Mac, in the models folder.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { modelsDir } from "./store.ts";
import { MLX_LM_VERSION, MLX_REQUIREMENTS } from "./mlx-lock.ts";

export const MLX_PYTHON = {
  version: "3.12.15+20261013",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-aarch64-apple-darwin-install_only_stripped.tar.gz",
  sha256: "9866e11cf2ae9caa1e671383786f248859a52dd8bfb702fb4c0dc2c65f1d36de",
};

export const mlxSupported = () => process.platform === "darwin" && process.arch === "arm64";

// Beside the models it serves, under a name the installed-model scan skips (it reads manifests).
export function mlxEngineDir(): string {
  return process.env.NITI_MLX_ENGINE_DIR ?? join(modelsDir(), ".engines", `mlx-${MLX_LM_VERSION}`);
}

const pythonPath = () => join(mlxEngineDir(), "python", "bin", "python3");
export const wrapperPath = () => join(mlxEngineDir(), "niti_mlx_server.py");
const stampPath = () => join(mlxEngineDir(), "INSTALLED");
const stamp = () => `${MLX_LM_VERSION} ${MLX_PYTHON.sha256}`;

// What a test can stand in for: the command that serves an MLX model (NITI_MLX_SERVER, a script
// taking the wrapper's arguments), so no Python is needed to test the runtime.
export function mlxServerCommand(): string[] | undefined {
  const fake = process.env.NITI_MLX_SERVER;
  if (fake) return fake.endsWith(".ts") ? [Bun.which("bun") ?? process.execPath, fake] : [fake];
  return mlxEngineInstalled() ? [pythonPath(), wrapperPath()] : undefined;
}

export function mlxEngineInstalled(): boolean {
  if (process.env.NITI_MLX_SERVER) return true;
  try {
    return readFileSync(stampPath(), "utf8").trim() === stamp() && existsSync(pythonPath());
  } catch {
    return false;
  }
}

export interface EngineProgress {
  stage: "python" | "packages" | "done" | "error";
  received?: number;
  total?: number;
  error?: string;
}

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

export function mlxEngineStatus(): { supported: boolean; installed: boolean; installing: boolean; bytes?: number } {
  const installed = mlxEngineInstalled();
  let bytes: number | undefined;
  if (installed && !process.env.NITI_MLX_SERVER) {
    try {
      bytes = dirBytes(mlxEngineDir());
    } catch {
      bytes = undefined;
    }
  }
  return { supported: mlxSupported() || !!process.env.NITI_MLX_SERVER, installed, installing: !!installing, ...(bytes ? { bytes } : {}) };
}

let installing: Promise<string[]> | undefined;

// Installs the engine if it isn't here yet; resolves with the command that serves a model. One
// install at a time: a second caller waits for the first instead of starting its own.
export function ensureMlxEngine(onProgress: (p: EngineProgress) => void = () => {}, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const ready = mlxServerCommand();
  if (ready) return Promise.resolve(ready);
  if (!mlxSupported()) return Promise.reject(new Error("MLX models run only on Apple Silicon Macs — pick the GGUF version of this model instead"));
  installing ??= install(onProgress, fetchImpl).finally(() => {
    installing = undefined;
  });
  return installing;
}

async function install(onProgress: (p: EngineProgress) => void, fetchImpl: typeof fetch): Promise<string[]> {
  const dir = mlxEngineDir();
  const url = process.env.NITI_MLX_PYTHON_URL ?? MLX_PYTHON.url;
  const sha = process.env.NITI_MLX_PYTHON_SHA ?? MLX_PYTHON.sha256;
  try {
    // A half-finished earlier attempt is started over: python/ and site-packages are not resumable.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tgz = join(dir, "python.tgz");
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`could not download Python for the MLX engine: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    const hash = createHash("sha256");
    const out = createWriteStream(`${tgz}.part`);
    let received = 0;
    let last = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      received += chunk.byteLength;
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress({ stage: "python", received, total });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (hash.digest("hex") !== sha) throw new Error("the Python download for the MLX engine failed its checksum — try again");
    renameSync(`${tgz}.part`, tgz);
    const x = Bun.spawnSync(["tar", "-xzf", tgz, "-C", dir]);
    rmSync(tgz, { force: true });
    if (x.exitCode !== 0 || !existsSync(pythonPath())) throw new Error(`could not unpack Python: ${x.stderr.toString().slice(-300)}`);

    onProgress({ stage: "packages" });
    const reqs = join(dir, "requirements.txt");
    writeFileSync(reqs, `${MLX_REQUIREMENTS}\n`);
    const pip = Bun.spawn([pythonPath(), "-m", "pip", "install", "--no-deps", "--require-hashes", "--only-binary=:all:", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "-r", reqs], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PIP_CONFIG_FILE: "/dev/null", PYTHONNOUSERSITE: "1" },
    });
    const [code, err] = await Promise.all([pip.exited, new Response(pip.stderr).text()]);
    if (code !== 0) throw new Error(`installing the MLX packages failed: ${err.trim().split("\n").slice(-3).join(" | ")}`);
    writeFileSync(wrapperPath(), WRAPPER);
    writeFileSync(stampPath(), `${stamp()}\n`);
    onProgress({ stage: "done" });
    return [pythonPath(), wrapperPath()];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: "error", error: message });
    rmSync(dir, { recursive: true, force: true });
    throw new Error(message);
  }
}

export function removeMlxEngine(): void {
  rmSync(mlxEngineDir(), { recursive: true, force: true });
}

// mlx_lm.server, made safe to leave running on a laptop. It has no API key and allows any origin,
// and a request's `model` field makes it download and load any model on the Hub. This wrapper
// requires niti's per-launch key on everything but /health, and serves only the model it was started
// with, whatever a request names.
export const WRAPPER = `import os, sys
from mlx_lm import server as S

KEY = os.environ.get("NITI_MLX_KEY", "")
H = S.APIHandler
_post, _get = H.do_POST, H.do_GET

def _authorized(self):
    if self.path.split("?")[0] == "/health":
        return True
    if KEY and self.headers.get("Authorization") == "Bearer " + KEY:
        return True
    body = b'{"error": "unauthorized"}'
    self.send_response(401)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)
    return False

def do_POST(self):
    if _authorized(self):
        return _post(self)

def do_GET(self):
    if _authorized(self):
        return _get(self)

H.do_POST, H.do_GET = do_POST, do_GET

_load = S.ModelProvider.load
def load(self, model_path, adapter_path=None, draft_model_path=None):
    return _load(self, "default_model", None, "default_model")
S.ModelProvider.load = load

if __name__ == "__main__":
    sys.argv[0] = "mlx_lm.server"
    S.main()
`;
