# Product follow-ups

Web follow-ups completed for v0.11.0 after the execution-isolation, session-sharing and production-recovery work.

- [x] Carry the UI revamp through the rest of the product, using the sidebar, Overview and Work pages as the established design language.
- [x] Finish the **Sessions** visual pass: the terminal shortcut and nested pane groups are done; unify the remaining terminal/chat layout, toolbar, collaboration controls, recovery states and responsive behavior.
- [x] Audit the remaining detail pages, Reviews, Inbox, Library and Settings for consistent typography, spacing, surfaces, forms, dialogs, loading/error states and empty states.
- [x] Preserve all existing functionality. Keep usage indicators visible, examples unobtrusive, and the work form ordered with the trigger before the prompt.
- [ ] **Deferred by request:** Check the resulting flows against iOS and Android for consistent concepts and complete functionality while keeping each platform's native interaction patterns.

Requested October 6, 2026. iOS and Android work stays queued for a later pass.

## Delivery

- [x] Add “Open terminal here” to local and pod sessions, opening an independent shell beside the current session.
- [x] Show multiplexed sessions as nested sidebar rows. Keep grouping in the current view's URL; do not write parent/child relationships to session records or synchronize layout across devices.
- [x] Get feedback on the local deployment before cutting a new release. User approved the local result: “This is perfect.”
- Release target: [v0.11.0](https://github.com/jonwiggins/optio/releases/tag/v0.11.0), after local verification.
