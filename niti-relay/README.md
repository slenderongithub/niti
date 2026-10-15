# niti-relay

The relay between niti on a Mac and the niti phone app. It does three things:

- **Sign-in.** Email plus a 6-digit code registers a device's public key under an account. From
  then on the key is the credential: a device proves itself by signing a challenge on every
  connect. There are no bearer tokens to steal.
- **Routing.** One WebSocket per device. A phone's frames reach a Mac session only after that Mac
  has allowed the phone (once, with a matching code shown on both screens). Before that, only the
  small cleartext pairing exchange behind that code passes between them. Each frame is
  end-to-end encrypted with keys made fresh on every connection, so the relay only ever sees
  ciphertext, device names, emails and push tokens.
- **Push.** Content-light notifications through Expo (approval needed, goal finished, Mac went
  offline), sent only to allowed phones that aren't connected right now.

The protocol lives in `../src/remote/protocol.ts`, shared with the core and the app. How it all fits:
`../project_context.md`.

## Run it

- **Cloudflare** (the hosted relay): see the steps at the top of `wrangler.toml`, then
  `npm run deploy`. Sign-in emails go through [Resend](https://resend.com); its free tier allows
  100 a day.
- **Your own box**: `bun bun.ts --port=8787`. The same code runs on Bun and SQLite. With no mailer,
  sign-in codes print to the console, and pushes are logged instead of sent. It listens on
  127.0.0.1 only; add `--host=0.0.0.0` so a phone on the same network can reach it.

Sign a Mac in to a relay with `/remote login <email> --relay https://…` in niti; the phone app
asks for the same relay URL. `remote: false` in a project's `.niti/agents.yaml` keeps that project
out of remote control.

## Test

`bun test`. This runs the room and sign-in logic against the Bun relay.
