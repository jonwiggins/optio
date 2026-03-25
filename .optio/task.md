# chore: Remove or implement Notion ticket provider stub

chore: Remove or implement Notion ticket provider stub

## Problem

The Notion ticket provider (`packages/ticket-providers/src/notion.ts`) is a stub — all methods throw "not yet implemented". It's listed as an option in the UI but will crash if selected.

## Options

1. Implement it using the Notion API
2. Remove it from the codebase and UI until ready

Either way, it shouldn't be selectable in its current state.

---

_Optio Task ID: 8acbbe70-4301-41be-a16e-7ae1b956f69e_
