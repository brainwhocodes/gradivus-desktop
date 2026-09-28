Tasks identified by verbatim content, NEVER generated IDs (task-1). Unique, stable task/phase names; lost text: view, NEVER guess.

## Operations

|`op`|Fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: (string \| {content, parent?})[]}]`|Replace the list; `parent` names an earlier same-phase task|
|`init`|`items: (string \| {content, parent?})[]`|Flattened single-phase init|
|`start`|`task`|Start the leaf or its first pending descendant|
|`done`|`task` or `phase`|Complete the targeted leaf subtree|
|`drop`|`task` or `phase`|Abandon the targeted leaf subtree|
|`block`|`task` or `phase`; optional `reason`|Block open leaves; blocked leaves NEVER auto-promote|
|`unblock`|`task` or `phase`|Blocked leaves → `pending`|
|`rm`|optional `task` or `phase`|Remove a task subtree/phase tasks; omit both → clear|
|`append`|`phase`; `items: (string \| {content, parent?})[]`|Append roots/children; lazily create the phase|
|`move`|`task`, destination `phase`; optional `parent`, `before`|Move a subtree; `before` MUST be a destination sibling|
|`view`|—|Read-only; echo list|

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Hierarchy

- `parent` names task content, NEVER an internal ID.
- Parents MUST precede descendants in the same phase.
- Only leaves are actionable; container status derives from descendants.
- Container actions cascade to every descendant leaf.
- First child reopens a completed/abandoned parent.
- `move` preserves the subtree and supports reorder/indent/outdent.
- Task content remains globally unique across all phases.

## Rules

- After successful mutation: if nothing is `in_progress`, earliest `pending` task (phase order) auto-promotes; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may rewind the pointer; completed tasks NEVER reopen.
- Mark leaf tasks done immediately; complete phases in order.
- NEVER make a todo call the turn's only tool call. Batch it with real work; init with first work, done/start with next action.
- External waits: `block` the leaf with an optional `reason`; unblock when actionable. Agent-actionable blockers: `append` a clearing child task.
- Keep introduced `task`/`phase` strings stable.
- Lost exact task text? `view`; NEVER guess.

## Create a list

- Task requires 3+ distinct steps.
- User explicitly requests one.
- User provides a set of tasks.
- New instructions arrive mid-task: capture before proceeding.

<critical>
User gives a multi-step plan, numbered checklist, or “N bugs/items/tasks”:
- MUST `init` every item as a leaf or explicit parent/child task.
- NEVER summarize, sample, omit, or track items only from memory.
- NEVER target tasks by generated IDs; use exact content.
</critical>
