---
name: product-description
description: Document a product's user experience from the outside in, tracing visible states, interactions, interruptions, edge cases, and verification evidence across a codebase.
---

# Product description

Use this skill when the user wants a product description, behavior map, UX specification, interaction documentation, or a durable explanation of how a product behaves. It is for the experience a user has, not API reference material or an implementation design.

## Outcome

Produce documentation that makes the product understandable as an externally observable state chart: what the user sees, what inputs are accepted, what changes immediately, what is committed, and what happens when the interaction is interrupted. Work within the user's requested surface and output location. If the project already has documentation conventions, preserve them and extend them consistently.

Do not invent behavior. Distinguish behavior established by tests, behavior observed in a running product, reasonable inference, and open questions. Record the source revision used for verification.

## Establish the scope

Before drafting, identify:

- the product surface being described, such as a route, workflow, command, default installation, or fresh-account experience;
- the default configuration and user role;
- the unit of interaction: gesture, form/page lifecycle, command invocation, conversation turn, or another product-specific unit;
- the major features and cross-cutting concerns in scope;
- the source locations for state, domain objects, UI, and behavioral tests; and
- whether a running product is available for observing visibility, timing, focus, and feedback.

If a requested scope is ambiguous but a safe default is clear, state the assumption in the document. Ask only when the ambiguity would materially change the documentation set.

## Research and draft

For each feature, inspect the relevant state transitions and domain rules, then read the matching tests as executable evidence. Use the running product when available to settle what is visible during an interaction and how timing or focus feels. Search for existing terminology and use the project's glossary rather than creating synonyms.

Write from the user's point of view. Mention implementation details only when they change the user's expectation, and put those details in a block quote beginning with `Technical note:`. Include surprising behavior and its known reason instead of smoothing it over.

When the documentation set is broad, create or maintain these shared artifacts:

- `README.md`: purpose, conventions, scope, work order, structure, and coverage table;
- `goal.md`: standing instructions for future contributors;
- `glossary.md`: the canonical product vocabulary;
- `bug-triage.md`: suspected defects with reproduction steps, rationale, severity, and the decision needed;
- `verification/`: hand-verification checklists; and
- feature, foundation, and cross-cutting documents organized by user-facing area rather than package or module.

Do not create every artifact for a small, narrowly scoped request. Match the document set to the requested outcome.

## Feature document contract

Use this skeleton for every feature document so behavior and gaps remain comparable:

1. **Summary** — one paragraph describing the feature.
2. **The simple case** — the common path in prose.
3. **The interaction, event by event** — explain the interaction's five phases: starting, ending at once, becoming extended, while extended, and finishing. State what starts it and is captured, what happens on an immediate end, what is decided when it becomes extended, what updates live, and what is committed at the end. Include a small Mermaid `stateDiagram-v2` showing the user-visible states.
4. **Modifiers** — table the relevant modifiers, roles, flags, record states, or modes. Describe their effect when set at the start and when changed during the interaction.
5. **Cancel and interrupt** — use the fixed checklist below, in the same order in every feature document.
6. **Interactions with other systems** — cover the fixed cross-cutting concerns below, in order; mark a concern not applicable instead of silently omitting it.
7. **Edge cases** — anything observable that the earlier sections do not cover.
8. **Open questions and verification** — source commit, observed/tested status, and behaviors that remain unconfirmed.

The interaction phases are a documentation lens, not a claim that the implementation has five literal states. Adapt the wording to the product while retaining the questions each phase asks.

## Fixed interrupt checklist

Adapt the examples to the product once, then reuse the same seven entries and order in every feature document:

1. The user's explicit abort: Escape, Stop, Ctrl+C, Cancel, or the product's equivalent.
2. The user doing something else mid-way: switching tools, modes, tabs, or conversations; navigating away; or submitting another action.
3. Events treated as a clean completion: a menu opening, undo or redo, or a submission from elsewhere.
4. The environment failing: focus loss, network loss, request failure, timeout, or session expiry.
5. The page or process going away: reload, tab close, terminal close, app backgrounding, or process exit.
6. Something else changing the target: deletion, locking, another user or tab editing it, or on-disk changes.
7. The input channel changing: a second device, autofill, a closed pipe, touch cancellation, or equivalent.

For each entry, state whether the interaction cancels, completes, rolls back, remains pending, or surfaces an error, and what the user sees.

## Fixed cross-cutting order

In every feature document, discuss these concerns in this order: permissions; history or undo; containers or parents; locked or read-only state; offline behavior; collaboration or multi-device behavior; notifications; configuration and preferences. Explain the observable consequence, or explicitly say that the concern does not apply.

## Verification and coverage

Verification checklists must contain one observable claim per item, with setup, steps, expected result, priority, device or environment, and a Result field for `pass`, `fail`, or `blocked`. A document is `verified` only when all P1 and P2 items have passed or have been filed in `bug-triage.md`; otherwise use `drafted` or `not started` in the coverage table.

Keep tests and runtime observations separate in the evidence. Tests establish what the product does under controlled conditions; runtime observation establishes visibility, timing, focus, and feedback. Do not call an inferred behavior verified.

## Quality bar

- Keep headings in sentence case and terminology consistent with `glossary.md`.
- End every feature document with the commit it was verified against and open questions.
- Describe one behavior once, at the user-facing point where it is encountered; use cross-cutting documents only for behavior that genuinely belongs there.
- Include edge cases and interruptions, not only the happy path.
- Replace all placeholders with project-specific prose. Do not leave template braces or TODO markers in deliverables.
- Do not reorganize documents by package merely because the implementation is organized that way.

The workflow is adapted from the product-description template at https://gist.github.com/steveruizok/83ae5c53f2784ebf8f5fe0a3fb94480f.
