Drives a real Chromium tab through Playwright 1.62.1 over CDP; exposes the raw `page` and `browser` objects.

<instruction>
- Static content? `read` the URL. Browser only for JS execution, auth, interactive actions.
- `open` → `run` — tabs survive calls and subagents, open once reuse. Omitted names use `main` for the top-level agent and `agent:<agentId>:main` for named subagents; explicit names are process-global collaboration handles.
- `run` calls on the same tab are serialized FIFO. Queue wait counts against the original timeout; cancellation removes a queued call. Different tabs run concurrently.
- `list` returns a bounded, sorted inventory of managed tab names, backend, URL/title, non-sensitive owner labels, and active/queued run counts. Use it before intentionally sharing an explicit tab.

  - Tab helpers (drop to the raw Playwright `page` for anything uncovered):
    Element handles: `tab.ref("e5")` / `tab.id(n)` return a handle you call methods on directly — `(await tab.id(n)).click()`. Handles are NOT selectors: `tab.click`/`type`/`fill`/`waitFor*` take STRING selectors only. Snapshot refs work in any selector slot: `tab.click("e5")` ≡ `tab.click("aria-ref=e5")`.
  Simple: `tab.goto`, `tab.click`, `tab.type`, `tab.fill`, `tab.press`, `tab.scroll`, `tab.scrollIntoView`, `tab.drag`, `tab.uploadFile`, `tab.select`, `tab.screenshot`, `tab.extract`, `tab.evaluate`.
  Screenshots: `tab.screenshot({ selector?, fullPage?, silent? })` saves to `browser.screenshotDir`, or OS temp when unset, then returns the path. It NEVER accepts a path.
  Waits: `tab.waitFor`, `tab.waitForSelector`, `tab.waitForUrl`, `tab.waitForResponse`, `tab.waitForNavigation`.
  Snapshots: `tab.observe()` → accessibility tree; `tab.ariaSnapshot()` → ARIA YAML with `[ref=eN]`.

  Gotchas:
  - `tab.fill` NEVER works for `<select>` — use `tab.select`.
  - `tab.waitForNavigation` must start BEFORE the trigger click.
  - Navigation and re-renders (virtualized lists, SPA updates) invalidate ids/refs — re-observe or re-snapshot, then act in the same cell.
  - Stalled actions fail fast with named error, never whole-cell timeout.
  - Raw request interception is run-scoped: run end removes `request` handlers, disables interception, releases held requests.

- Gradivus terminal? If no explicit app backend or configured relay/CDP/cmux backend is selected, browser automation fails closed until the authenticated pane-scoped runtime broker is connected. Never fall back to a global Electron CDP endpoint, title/URL matching, or an implicit pane-name target. Explicit `app.cdp_url`, `app.path`, `app.relay`, or cmux configuration remains subject to the tool's backend rules.
- `app.path` → NEVER tamper with a real desktop app (no stealth patches).
- `app.relay: true` → drive the user's own external Chrome tabs via the omp browser relay (auto-started; needs the OMP Browser Relay extension installed). `app.target` picks a tab by URL/title substring; without it the visible tab is adopted — and an `open` carrying `url` navigates that adopted tab. Gradivus does not synthesize a matcher from the logical tab name.
- Relay can also engage without `app.relay` when the `browser.relay` setting is on; every relay open result says `on relay`. Either way you are inside the user's REAL logged-in browser: every tab, session, and click belongs to the user and sites attribute your actions to their account. Name a target (or create your own tab), never navigate the user's visible tab uninvited, take no consequential action the user didn't ask for, and `close` when done.
- `close` releases the named tool session. It closes tool-owned headless pages and owned cmux surfaces, but NEVER closes pages in CDP-connected or relay browsers. Spawned-browser pages remain open unless `kill: true` terminates their process.
- Selectors: CSS, Playwright selector engines, and `aria/…`, `text/…`, `xpath/…`, `pierce/…` namespaces are supported. Legacy `p-aria/`, `p-text/`, `p-xpath/`, and `p-pierce/` prefixes are normalized; unsupported `p-*` prefixes are rejected.
</instruction>

<critical>
- MUST `open` before `run`. Default to `tab.observe()`; screenshot only for appearance. `code` runs with full Node access — not sandboxed.
</critical>
