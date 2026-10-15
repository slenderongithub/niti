# niti-mobile

The niti iPhone app: a remote control for niti running on your Mac. It shows what the team is doing,
lets you steer it (a note to a goal, a message to an agent, interrupting one agent), answer approvals
(Face ID for risky ones), pause or stop a goal, and merge the result. Everything still runs on the Mac.
The phone only sends instructions, end-to-end encrypted through the relay (`../niti-relay`).

It shares code with the rest of the repo rather than copying it:

- `../src/remote/protocol.ts`: the wire protocol and encryption.
- `../niti-app/src/renderer/src/lib/`: the desktop app's session reducer and types.
- `../niti-app/src/renderer/src/assets/avatars/`: the agents' pixel avatars.

A change to either is checked against this app too (`npm run typecheck`).

## Design

It wears the desktop app's design language, redrawn for a phone: the same colour tokens
(`src/lib/colors.ts`, checked against `niti-app/.../styles/globals.css` by `colors.test.ts`), Inter
and JetBrains Mono, the same radii, the shadcn variants as React Native components
(`src/components/ui.tsx`), the agents rail and transcript rows (`src/components/items.tsx`), the
braille spinner and the `niti.` wordmark. Type runs two points above the desktop's, and every control
reaches 44pt. A design change on the desktop gets its matching change here.

## Run it

Expo SDK 57. Push notifications, Face ID and the Keychain need a development build. Expo Go can't
receive remote pushes.

```sh
npm install
npx eas-cli@latest init          # once: links an Expo project (sets extra.eas.projectId, needed for push)
npx eas-cli@latest build --profile development --platform ios
npx expo start                   # then open the dev build on your iPhone
```

Building for a device needs an Apple Developer account. Set the relay URL in `app.json` under
`extra.relay`, or type it on the sign-in screen.

## Use it

1. On the Mac: `/remote login you@example.com --relay https://your-relay`, then `/remote code <digits>`.
2. On the phone: sign in with the same email.
3. On the Mac: allow the phone when niti asks, if the code matches the one the phone shows.

## Check it

`npm run typecheck`, `npm test`, and `npx expo export --platform ios` (bundles without a device). The
end-to-end check of the whole remote path (core, relay and this app's client library) is
`bun ../scripts/e2e/remote.ts`.
