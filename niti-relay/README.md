# niti-relay

The relay between niti on a Mac and the niti phone app. It does three things:

- **Registering.** A device registers its public key under an email, signed with that key. The
  email is only a name that groups someone's Macs and phones: the relay never sends it anything.
  From then on the key is the credential: a device proves itself by signing a challenge on every
  connect. There are no bearer tokens to steal, and nothing to configure (no mail service).
- **Routing.** One WebSocket per device. A phone's frames reach a Mac session only after that Mac
  has allowed the phone, which takes the code shown on the Mac, typed on the phone. Before that,
  only the small cleartext pairing exchange passes between them, and it doesn't reveal the code
  (CPace, in `../src/remote/protocol.ts`). Each frame is end-to-end encrypted with keys made fresh
  on every connection, so the relay only ever sees ciphertext, device names, emails and push tokens.
- **Push.** Content-light notifications through Expo (approval needed, goal finished, Mac went
  offline), sent only to allowed phones that aren't connected right now.

The protocol lives in `../src/remote/protocol.ts`, shared with the core and the app. How it all fits:
`../project_context.md`.

## Run it

- **Cloudflare, free plan** (the relay niti and the app are built to use):
  ```sh
  npx wrangler login
  npx wrangler d1 create niti-relay   # put the database_id it prints in wrangler.toml
  npx wrangler deploy                 # prints https://niti-relay.<you>.workers.dev
  ```
  Then put that address in `DEFAULT_RELAY` (`../src/remote/identity.ts`) and `extra.relay`
  (`../niti-mobile/app.json`). One relay serves every user; each account gets its own Durable Object.
- **Your own box**: `bun bun.ts --port=8787`. The same code runs on Bun and SQLite; pushes are logged
  instead of sent. It listens on 127.0.0.1 only; add `--host=0.0.0.0` so a phone on the same
  network can reach it. Point niti at it with `/remote on <email> --relay http://…`.

`remote: false` in a project's `.niti/agents.yaml` keeps that project out of remote control.

## Test

`bun test`. This runs the room and registration logic against the Bun relay.
