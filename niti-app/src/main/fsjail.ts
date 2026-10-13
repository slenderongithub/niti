import { lstatSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The editor's file access, held to the project: a path is only readable or writable if it
// resolves — symlinks followed — to somewhere inside the project root. The engine has no write
// route, so this is the one place the app writes into a project, and it is the user doing it.

const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export class JailError extends Error {}

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes(".."));
}

// The absolute path for `rel`, or a JailError. For a file that doesn't exist yet, its nearest
// existing parent must resolve inside the root.
export function resolveInRoot(root: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) throw new JailError(`not a project path: ${rel}`);
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, rel);
  if (!inside(realRoot, abs)) throw new JailError(`outside the project: ${rel}`);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (!inside(realRoot, real)) throw new JailError(`outside the project (through a link): ${rel}`);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink() && !inside(realRoot, realpathSync(abs))) throw new JailError(`outside the project (through a link): ${rel}`);
  return abs;
}

export function readProjectFile(root: string, rel: string): { content: string; mtimeMs: number } {
  const abs = resolveInRoot(root, rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new JailError(`not a file: ${rel}`);
  if (st.size > MAX_EDIT_BYTES) throw new JailError(`too large to edit here (${Math.round(st.size / 1024)} KB)`);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new JailError("binary file");
  return { content: buf.toString("utf8"), mtimeMs: st.mtimeMs };
}

// Writes atomically (temp file + rename). `expectedMtime` guards against overwriting a change made
// since the file was loaded — an agent's edit, a formatter, another editor.
export function writeProjectFile(root: string, rel: string, content: string, expectedMtime?: number): { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number } {
  const abs = resolveInRoot(root, rel);
  if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new JailError("too large to save here");
  if (expectedMtime !== undefined && existsSync(abs)) {
    const now = statSync(abs).mtimeMs;
    if (Math.abs(now - expectedMtime) > 1) return { ok: false, conflict: true, mtimeMs: now };
  }
  const tmp = join(dirname(abs), `.${Date.now()}.niti-save`);
  writeFileSync(tmp, content);
  if (existsSync(abs)) chmodSync(tmp, statSync(abs).mode); // the rename replaces the file: keep its mode (a script's +x)
  renameSync(tmp, abs);
  return { ok: true, mtimeMs: statSync(abs).mtimeMs };
}
