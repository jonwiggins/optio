# Product follow-ups

Web follow-ups after the execution-isolation, session-sharing and production-recovery work. v0.11.0 shipped the pod Sessions redesign; the Local Sessions visual pass was missed and is completed in the follow-up below.

- [x] Carry the UI revamp through the rest of the product, using the sidebar, Overview and Work pages as the established design language.
- [x] Finish the **pod Sessions** visual pass: unify the terminal/chat layout, toolbar, collaboration controls, recovery states and responsive behavior.
- [x] Finish the **Local Sessions** visual pass (`/local/:id`): refresh the session rail, separate identity/location from controls, retain usage indicators at narrow widths, restyle the transcript and composer, and keep scrolling within the session. Verify this route directly, including chat input and terminal switching.
- [x] Audit the remaining detail pages, Reviews, Inbox, Library and Settings for consistent typography, spacing, surfaces, forms, dialogs, loading/error states and empty states.
- [x] Preserve all existing functionality. Keep usage indicators visible, examples unobtrusive, and the work form ordered with the trigger before the prompt.
- [x] **Deferred by request:** Check the resulting flows against iOS and Android for consistent concepts and complete functionality while keeping each platform's native interaction patterns. iOS: v0.14.0 (New work form parity) and v0.15.0 (work cards, session headers). Android: the parity pass after v0.15.0 — the v0.15 work cards and session headers, the Overview's Needs-you section on the same cards, the fourteen trigger types in the automations and agent trigger sheets through the work form's editor, the one-time secret dialog, and a walk of Overview, Work, work details, sessions, Reviews, Inbox, Library and Settings against the web.

Requested October 6, 2026.

## Delivery

- [x] Add “Open terminal here” to local and pod sessions, opening an independent shell beside the current session.
- [x] Show multiplexed sessions as nested sidebar rows. Keep grouping in the current view's URL; do not write parent/child relationships to session records or synchronize layout across devices.
- [x] Get feedback on the local deployment before cutting a new release. User approved the local result: “This is perfect.”
- Released: [v0.11.0](https://github.com/jonwiggins/optio/releases/tag/v0.11.0). The Local Sessions visual follow-up is tracked under Unreleased.
