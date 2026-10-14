import type { Accounts } from "./accounts.ts";

// The two sign-in endpoints, shared by the Cloudflare Worker and the Bun relay.
//   POST /v1/login/start  {email}                         → a code goes to that inbox
//   POST /v1/login/verify {email, code, device:{name, kind, signPub}} → {account, device}
// `signedIn` lets the account's live room tell everyone a device arrived.
export async function login(req: Request, accounts: Accounts, signedIn: (account: string) => Promise<void>): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST" || (path !== "/v1/login/start" && path !== "/v1/login/verify")) return undefined;
  let body: { email?: string; code?: string; device?: { name: string; kind: "mac" | "phone"; signPub: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
  }
  if (path === "/v1/login/start") {
    const r = await accounts.start(body.email ?? "");
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  const r = await accounts.verify(body.email ?? "", body.code ?? "", body.device!);
  if (!r.ok) return Response.json(r, { status: 400 });
  await signedIn(r.account);
  return Response.json(r);
}
