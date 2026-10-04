# Web UI building blocks

The design language of the Overview (`app/page.tsx`, `components/dashboard/`) and
the New work form (`components/work-form/`). Use these instead of re-typing the
classes, so refreshed pages stay consistent. Colours come from the theme tokens
in `app/globals.css` (`primary`, `success`, `warning`, `error`, `text-muted`, …;
there is no `danger`).

## In `components/ui/`

| Component                                                          | Use for                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SectionCard` (`section-card.tsx`)                                 | A form / settings block: `rounded-xl` card, `bg-bg-subtle/70` header strip with optional numbered `step` circle, `label`, inline `hint`, right-aligned `summary` (+ `summaryIcon`) and `actions`, then a `p-4` body (`bodyClassName` to change).                                |
| `Segmented`, `SegmentedGroup`, `SegmentedButton` (`segmented.tsx`) | Either/or pill toggles. `options: { value, label, icon?, disabled?: reason, count? }[]`; `size` `sm` (forms, text-xs) / `md` (page views, text-sm); `surface` `bg` (inside cards) / `card` (on the page); `wrap`. Compose Group + Button when you need custom pills.            |
| `Disclosure` (`disclosure.tsx`)                                    | A chevron "More options" toggle that reveals its children (`open`, `onToggle`, `label`).                                                                                                                                                                                        |
| `Panel`, `PanelEmpty` (`panel.tsx`)                                | A list card: `rounded-xl border-border/70`, `bg-bg-card/60` header strip with an uppercase `title` and right-side `actions` (`All →`, `+ New`), flush body of `divide-y` rows. `PanelEmpty` is its one-line empty message.                                                      |
| `OwnerSegments` + `useOwnerFilter` (`owner-segments.tsx`)          | The scope switch every list of scoped resources carries, in the page header's row: **All · Organization · Private** (+ **Other people's** for an admin), counts from the rows, the choice in `?owner=`.                                                                         |
| `ScopedList` (`scoped-list.tsx`)                                   | Rows grouped by scope. `All` renders one `Panel` per scope (Organization / Private / Other people's) so every scope shows at a glance; any other filter renders the matching rows flat. `render(rows, scope)` draws the rows; `privateEmpty` is the Private section's one line. |
| `OwnerPicker` (`owner-picker.tsx`)                                 | The **Owner** row in every create / edit form: Organization or Private, one helper sentence per resource (`what`), the Organization pill disabled with its reason when the viewer can't make one (`canOrg`).                                                                    |
| `OwnerChip` (`owner-chip.tsx`)                                     | The chip for a private row where scopes mix without sections (search, the Work list, pickers, detail headers): **Private** for the viewer's own, **Private · Name** for someone else's. Organization rows carry none.                                                           |
| `StatTile` (`stat-tile.tsx`)                                       | A headline number: uppercase 11px `label` with `icon`, `text-2xl tabular-nums` `value`, `tone` (e.g. `text-warning`) only when it needs attention, optional `href`. Lay out in a `grid gap-3`.                                                                                  |

## Elsewhere in `components/`

| Component                                                            | Use for                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader` (`page-header.tsx`)                                     | Top of every list / index page: `icon`, `title`, one-line `description`, right `actions`, inline `meta` (counts).                                             |
| `DetailHeader` (`detail-header.tsx`)                                 | Top of a detail page for a task / review: `subtitle`, `title`, `state` badge, `metaItems` chips, `extraBadges`, `rightSlot`, `actions` row.                   |
| `EmptyState` (`empty-state.tsx`)                                     | Any "nothing here" state. `size="page"` (list pages, default) or `"panel"` (inside an Overview panel); `action` is a node or `{ label, href }` for the + CTA. |
| `MetadataCard` (`metadata-card.tsx`)                                 | A small labelled fact tile on detail pages (`icon`, `label`, `value`, `size` `sm` / `lg`).                                                                    |
| `StateBadge` (`state-badge.tsx`)                                     | A task / run / review state as a coloured dot + label. Never hand-colour a state.                                                                             |
| `BrandIcon`, `TriggerIcon`, `AgentIcon`, `PrIcon` (`brand-icon.tsx`) | The marks for GitHub / Slack / Linear …, a trigger type, an agent runtime, and a PR's open / merged / closed state. Use these, not ad-hoc Lucide icons.       |

## Scope

Every scoped resource (secrets, connections, model providers, MCP servers, skills, prompts, work)
carries `ownerUserId`: null = the **organization's**, set = someone's **private** one. The helpers
in `lib/owner.ts` (`ownerScope`, `countByOwner`, `inOwnerFilter`) and the current user from
`hooks/use-current-user.ts` (`userId`, `isAdmin`) feed the four components above. The vocabulary
is fixed: pickers say Organization / Private, sections and segments say Organization / Private /
Other people's, chips say Private. See `docs/plans/org-scoping-and-sso.md`.
