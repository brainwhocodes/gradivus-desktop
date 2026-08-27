# Standing goal for product documentation

Maintain an evidence-backed description of the Gradivus OMP Chat experience as an externally observable state chart. A reader should be able to answer, without reading TypeScript or Svelte:

- what the user sees before, during, and after an interaction;
- which input is captured and which container owns it;
- what changes immediately, what remains pending, and what becomes durable;
- how completion, cancellation, interruption, and recovery differ;
- which behaviors are user-configurable;
- which claims were observed, tested, read from production code, inferred, or left open; and
- which suspected defects need a product or engineering decision.

## Scope discipline

The primary surface is the fixed **OMP Chat** tab in the Gradivus Electron application. Include the session rail, composer, conversation transcript, active-turn controls, Agent Hub, Files inspector, Local terminal drawer, Settings routes that affect chat, extension requests, in-app notifications, and browser-selection delivery to chat.

Generic browser navigation, browser split layout, packaging, release engineering, the terminal-only OMP CLI/TUI, SDK contracts, and implementation architecture are outside scope unless their behavior changes a chat user's expectation. Link to repository engineering documentation instead of recreating it.

Assume a local desktop user, a normal writable local workspace, a Work session, and default machine-local settings unless a feature document says otherwise. Describe other modes as modifiers, not as a new default.

## Evidence rules

1. Record the Git revision anchor and whether relevant working-tree changes exist.
2. Read the production state transition before relying on a test name.
3. Read the matching behavioral test as executable evidence.
4. Run the actual Electron journey when the current checkout supports it. Tests establish controlled behavior; runtime execution establishes that the real shell, renderer, focus, visibility, and feedback path work together.
5. Keep evidence classes distinct: **Observed**, **Tested**, **test-specified but not run**, **Code-established**, **Inference**, and **Open question**.
6. Do not call an inference verified.
7. Do not treat copied test harnesses as proof of mounted renderer behavior.
8. Preserve surprising behavior and known limits. Do not rewrite a defect into an intended product rule.
9. Use the canonical terms in [`glossary.md`](./glossary.md). Quote interface labels when they intentionally differ.
10. Put implementation information in a block quote beginning with `Technical note:` only when it changes user expectations.

## Feature-document contract

Every file under `features/` must use this order:

1. Summary.
2. The simple case.
3. The interaction, event by event: starting, ending at once, becoming extended, while extended, and finishing.
4. A small `stateDiagram-v2` of user-visible states.
5. Modifiers.
6. Cancel and interrupt, with the seven standard interruption classes in their fixed order.
7. Interactions with other systems, with the eight cross-cutting concerns in their fixed order.
8. Edge cases.
9. Open questions and verification.

The seven interruption classes are: explicit abort; doing something else mid-way; events treated as clean completion; environment failure; page or process exit; another actor changing the target; and input-channel change.

The cross-cutting order is: permissions; history or undo; containers or parents; locked or read-only state; offline behavior; collaboration or multi-device behavior; notifications; configuration and preferences.

End each feature document with the revision anchor, runtime/test status, source evidence, and unresolved questions. A feature document is **verified** only when every P1 and P2 checklist item has passed or the failing behavior is filed in [`bug-triage.md`](./bug-triage.md).

## Verification-checklist contract

Each checklist claim must be observable and include:

- setup;
- steps;
- expected result;
- priority (`P1`, `P2`, or `P3`);
- device or environment;
- evidence source; and
- Result with exactly `pass`, `fail`, or `blocked`.

One item proves one claim. Do not use “the screen works,” source-text assertions, non-empty checks, or visual wording without a user-visible contract. Record fixture-backed Electron execution separately from real-provider or external-network execution.

## Update order

1. Read this file, [`README.md`](./README.md), and [`glossary.md`](./glossary.md).
2. Identify the changed user-facing state and every interruption it affects.
3. Update the owning feature document once; link from cross-cutting documents instead of duplicating behavior.
4. Update or add observable checklist claims.
5. Run the narrowest actual Electron journey that exercises the change.
6. Update coverage status and evidence dates.
7. Add, resolve, or reclassify triage entries.
8. Check local links, feature-section order, terminology, and revision anchors.

## Non-goals

- API reference material.
- An implementation plan or component inventory presented as UX.
- A marketing description that omits failure and interruption behavior.
- A guarantee that every implementation branch is desirable.
- A substitute for executable tests or direct runtime inspection.