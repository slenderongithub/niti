# niti-mobile

The niti iPhone app: a remote control for niti running on your Mac. Leave a `/goal` running (with
`/awake` keeping the Mac up) and walk away. From the phone you see what the team is doing and change
course: a note to the goal, a message to one agent, interrupting it, answering approvals, pausing or
stopping, merging the result. **Everything still runs on the Mac.** The phone only sends
instructions, end-to-end encrypted through the relay (`../niti-relay/`); provider keys and the core's
token never leave the Mac.

How it fits with the rest of the repo: `../project_context.md`.

## Screens

- **Pair** (`src/app/sign-in.tsx`): the email the Mac was turned on with and the code it shows. Once
  per Mac; "Pair another Mac" on Projects opens it again.
- **Projects** (`macs.tsx`): each Mac this phone paired with and the projects running on it: goal
  round, working or idle, approvals waiting, last seen.
- **Session** (`session/[mac]/[session]/index.tsx`): a status strip (link, goal, awake, context,
  tokens and cost), approvals waiting, the goal card (pause, resume, 5 more rounds, stop), then Team,
  Tasks and Changes (merge or discard a worktree), and the composer: a note while a goal runs, a
  message to the working agent mid-run, a new run when idle, or any `/command`.
- **Agent** (`session/[mac]/[session]/agent/[id].tsx`): one agent's transcript, row for row as the
  desktop draws it, with Send (read at its next turn) and Interrupt (stop now, carry on from this).
- **Approval** (`approval.tsx`, a page sheet): who wants to do what, the command or the diff, then allow,
  always for this agent, always in this folder, deny, or deny and say why. Risky requests need Face ID
  and never offer "always". If the Mac answered first, it says so.
- **Settings** (`settings.tsx`): which notifications, Face ID to open, the account's devices, sign out.

Notifications (approval waiting, goal ended, errors, a Mac going offline) open the right session, or
the approval sheet straight away. They say what happened, never code or commands.

## Shared code, not copies

- `../src/remote/protocol.ts`: the wire protocol, pairing and encryption (with the core and relay).
- `../niti-app/src/renderer/src/lib/`: the desktop app's session reducer, types, humanize, identity,
  diff and format. The phone folds a project's events with the same reducer as the desktop.
- `../niti-app/src/renderer/src/assets/avatars/`: the agents' pixel avatars.

Metro watches those folders (`metro.config.js`). A change to any of them is checked against this
app too.

## Design

It wears the desktop app's design language, redrawn for a phone, and must keep doing so:

- **Colours**: the same tokens (`src/lib/colors.ts`). `colors.test.ts` reads
  `niti-app/src/renderer/src/styles/globals.css` and fails if any value drifts.
- **Type**: Inter for words, JetBrains Mono for anything code-shaped (models, paths, commands,
  numbers in columns), two points above the desktop's scale (`src/lib/theme.ts`).
- **Components** (`src/components/ui.tsx`): the desktop's shadcn variants as React Native
  components: Button (default, secondary, outline, ghost, destructive, link), Badge, Card with header,
  content and footer, Tabs, Field, Progress, CodeBlock, EmptyState, the uppercase SectionLabel, the
  braille Spinner and the `niti.` wordmark.
- **Patterns** (`src/components/items.tsx`, `avatar.tsx`): the agents rail (avatars that blink and
  bob, model in mono, context bars, the lead's ★), transcript rows (tool one-liners with a check or a
  spinner, shell and diff blocks, notes by tone, your messages as bubbles, the card niti's acceptance
  checks on a local agent's work make: failures with what to fix, what passed folded), lowercase
  status words.
- **Phone rules**: every control reaches 44pt; motion stops under Reduce Motion (one shared clock,
  `src/lib/ticker.ts`); haptics and Face ID are native. Nothing else is: iOS draws its own title bar,
  alerts, action sheets, part-height sheets and switches in Liquid Glass, which ignores niti's colours,
  so the app draws its own: the title bar (`src/components/header.tsx`), alerts and menus
  (`src/components/dialog.tsx`, the desktop's AlertDialog, called like `Alert.alert`), the Switch
  (`ui.tsx`), and full page sheets for Approval and Settings. Don't use `Alert`, `ActionSheetIOS`,
  React Native's `Switch` or a `formSheet`. Header actions are labelled, not bare icons. The avatars
  are preloaded at launch.

A design change on the desktop gets its matching change here, and the other way round.

## Run it

**On a real iPhone, with push** (the way it ships): Expo SDK 57, a development build.

```sh
npm install
npx eas-cli@latest init          # once: links an Expo project (sets extra.eas.projectId, needed for push)
npx eas-cli@latest build --profile development --platform ios
npx expo start                   # then open the dev build on your iPhone
```

Building for a device needs an Apple Developer account. The relay's address is built in:
`extra.relay` in `app.json` (`../niti-relay/README.md` deploys one on Cloudflare's free plan).

**To look at it with no accounts or keys** (Expo Go, everything but push):

1. Run a local relay: `cd ../niti-relay && bun bun.ts --port=8787 --host=0.0.0.0`, and put its
   address (`http://<mac-ip>:8787`, or a public tunnel to it for a phone on mobile data) in
   `extra.relay`.
2. Start Expo: `npx expo start --lan` with the phone on the same Wi-Fi as the Mac, or
   `npx expo start --tunnel` when it isn't (needs `npm i -g @expo/ngrok`). Recent Expo Go versions want
   the phone and the Mac signed in to the same free Expo account (`./node_modules/.bin/expo login`).
3. Scan the QR code with the Camera app.
4. On the Mac, in this repo's build (`bun run build:all && ./niti`):
   `/remote on <email> --relay http://localhost:8787`, then pair as below.

## Pairing

1. On the Mac: `/remote on you@example.com`. The email is only a name for your devices: nothing is
   sent to it. niti shows a 6-digit code for 10 minutes (`/remote pair` makes another).
2. On the phone: type the same email and the code. That's it; both reconnect on their own from then on.

The code never crosses the relay: both sides run CPace over it (`../src/remote/protocol.ts`), so the
relay can't learn it, and a code allows 5 tries. The phone pins the Mac's key and only ever opens
Macs it paired with.

## Check it

```sh
npm run typecheck
bun test ./src                          # colours vs the desktop's, the colour resolver
npx expo export --platform ios          # bundles without a device: proves every shared import resolves
npx expo-doctor
bun ../scripts/e2e/remote.ts            # the whole remote path: core, relay and this app's client library
```
