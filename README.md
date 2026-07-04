# CozyCast

CozyCast is a minimal private two-person watch room built with Next.js, TypeScript, and WebRTC. One person creates a room, shares a screen or browser tab with audio, and a second person joins the same URL to watch. The viewer only watches; the media flow is host to viewer.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Setup

```bash
npm install
npm run dev
```

The app runs on `http://localhost:3000`.

For local development, CozyCast uses in-memory room state inside the Next.js server process. For Vercel or any multi-instance deployment, copy `.env.example` to `.env.local` and configure both Redis-backed room state and a TURN server.

## Available scripts

- `npm run dev` starts the Next.js development server.
- `npm run build` creates the production Next.js build.
- `npm start` runs the production Next.js server.

## Local testing flow

1. Open `http://localhost:3000` in browser window 1.
2. Click `Create Room`.
3. Copy the room URL and open it in browser window 2.
4. In window 1, click `Start Sharing` and choose a tab or window with audio if you want sound.
5. Window 2 joins the same room and watches the shared stream.
6. Click `Stop Sharing` to end the stream.

If a third person opens the same room URL, they receive a room-full message.

## Vercel deployment

CozyCast is now structured for Vercel:

- The frontend and API routes run on Next.js route handlers.
- Room membership and signaling events use Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, are configured.
- Local development falls back to in-memory state automatically.

Without Redis, a multi-instance deployment will not keep rooms consistent across function instances.

## Redis configuration

Provide one of these environment variable pairs:

```bash
KV_REST_API_URL=https://example.upstash.io
KV_REST_API_TOKEN=replace-me
```

or

```bash
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace-me
```

## TURN configuration

CozyCast now supports custom ICE server configuration so the WebRTC connection can relay through TURN when direct peer-to-peer networking is weak or blocked.

### Simple TURN setup

Create `.env.local`:

```bash
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=cozycast
TURN_CREDENTIAL=replace-me
```

This keeps the default Google STUN server and adds your TURN relay.

### Full ICE server list

If you want to provide multiple STUN/TURN servers, use:

```bash
ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"cozycast","credential":"replace-me"}]
```

When no TURN config is present, CozyCast falls back to STUN-only direct connectivity.

## Quality presets

The host can choose between `Smooth`, `Balanced`, `Sharp`, and `Max` quality presets before starting a share. `Max` targets up to `3840x2160` at `60fps`, though browsers and displays may clamp the actual capture lower. Changing the preset while sharing updates the active video track and sender parameters on a best-effort basis.

## How signaling works

Room signaling now happens through Next.js API routes backed by local memory or Redis. Media itself still stays WebRTC peer-to-peer or TURN-relayed.

1. The first socket to join a room becomes the `host`.
2. The second socket becomes the `viewer`.
3. The room client polls `/api/rooms/[roomId]/events` for signaling events and presence updates.
4. When the viewer joins, the server stores a `user-joined` event for the host.
5. After the host starts screen sharing, the host creates an `RTCPeerConnection` with the configured ICE servers, adds the display stream tracks, creates an SDP `offer`, and posts it to `/api/rooms/[roomId]/events`.
6. The viewer receives the `offer`, creates its own `RTCPeerConnection`, sets the remote description, creates an SDP `answer`, and posts it back.
7. Both sides exchange `ice-candidate` messages through the same signaling API until the peer-to-peer connection is established.
8. If either person disconnects, the server stores a `user-left` event so the other side can update room state.

Local development uses in-memory room state. Production Vercel deployments should use Redis-backed state.

## Project structure

```text
app/
  api/rooms/[roomId]/
  page.tsx
  room/[roomId]/page.tsx
components/
  create-room-button.tsx
  room-client.tsx
lib/
  ice-servers.ts
  room-store.ts
```

## Notes

- CozyCast targets exactly two people per room.
- Screen sharing uses `navigator.mediaDevices.getDisplayMedia(...)` with host-selected quality presets.
- STUN defaults to `stun:stun.l.google.com:19302`, and TURN can be added through environment variables.
- Vercel-compatible deployments should configure Redis-backed room state.
