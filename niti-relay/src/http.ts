import type { Accounts } from "./accounts.ts";

// The one sign-in endpoint, shared by the Cloudflare Worker and the Bun relay:
//   POST /v1/register {email, device:{name, kind, signPub, sig}} → {account, device}
// `signedIn` lets the account's live room tell everyone a device arrived.
// Bun builds an upgrade request's url from a bare IPv6 Host header without its brackets, which
// `new URL` rejects; the host never matters here, only the path and query.
export const urlOf = (req: Request): URL => new URL(req.url.replace(/^\w+:\/\/[^/]*/, ""), "http://relay");

export async function register(req: Request, accounts: Accounts, signedIn: (account: string) => Promise<void>): Promise<Response | undefined> {
  if (req.method !== "POST" || urlOf(req).pathname !== "/v1/register") return undefined;
  let body: { email?: string; device?: { name: string; kind: "mac" | "phone"; signPub: string; sig: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
  }
  const r = await accounts.register(body.email ?? "", body.device!);
  if (!r.ok) return Response.json(r, { status: 400 });
  await signedIn(r.account);
  return Response.json(r);
}
