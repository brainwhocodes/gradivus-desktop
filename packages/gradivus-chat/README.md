# Gradivus Chat

The hosted app is a browser client of Gradivus Desktop. It serves static HTML, JavaScript, styles, and assets; it does not run OMP on a web server. Desktop owns sessions, provider credentials, tool execution, and local file access.

## Run locally

From this package, run `bun run dev` and open `http://127.0.0.1:5190`. Run `bun run start` in `packages/desktop` to start the development Desktop app, choose **Connect to Desktop**, and approve the request in Desktop. The localhost browser client is enabled for unpackaged Desktop builds; packaged builds use the production origin.

`bun run build` creates the static site in `dist/`. Production uses the registered origin `https://gradivus.brainwhocodes.rocks`. A static host must serve `index.html` for `/auth/callback`; that route receives the one-time authorization code. A different origin requires a corresponding registered Desktop client, not a server-side OMP process.

## Connection behavior

- The browser talks directly to Desktop's fixed loopback listener at `http://127.0.0.1:47832` using OAuth authorization code + PKCE, authenticated command requests, uploads, and streamed events.
- Browser and Desktop currently need to be on the **same computer**. This implementation does not include a relay or cross-device transport.
- The access token stays in the browser tab's memory. Reloading the tab requires a new connection. Provider credentials remain in Desktop.
- Native folder pickers, opening files, and managing provider accounts request an additional Desktop permission when needed.
- An interrupted stream pauses actions and offers reconnect. Reconnect refreshes the session registry and snapshots while preserving the open chat's unsent draft. Expired or revoked access requires a new approval.
- Disconnect clears the tab's connection and asks Desktop to revoke its grant. When Desktop is unavailable, the UI explains that the grant can be removed from Desktop's Accounts settings.

The shared workspace in `src/lib` also renders inside the Electron app. Its fixtures and browser journeys are under `e2e/`; they model Desktop responses without running a second agent backend.

## Files and artifacts

The Files inspector lists successful file writes/edits and structured image-generation or speech outputs from the current chat. Search by path or filter Images, Video, Audio, Docs, Code, and Other. Select a file for a preview; text changes also offer a diff. Generated outputs outside the workspace use session-scoped references, not arbitrary local paths, and expired outputs remain visible with an explanation.

Audio and video use native browser playback controls without autoplay. Preview transport is authenticated and bounded: media payloads are limited to 8 MiB, image decode inputs to 20 MiB, and UTF-8 text to 256 KiB. Unsupported codecs, binary documents, or larger files offer Desktop Open rather than a misleading empty preview. SVG is displayed only as an image; HTML and code remain inert text. Native Open reveals scripts and active document formats such as HTML/SVG instead of executing them.

## Checks

Run `bun run check:types`, `bun run test`, `bun run build`, and `bun run test:e2e`. The original package-wide `check` additionally runs Biome over the entire package, including generated Svelte-check output; use its diagnostics to distinguish existing formatting issues from changed code.
