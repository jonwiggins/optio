/**
 * `:core:terminal`: the terminal for Optio Local terminals and pod sessions, on Termux's
 * `terminal-emulator` + `TerminalRenderer` (their classes only: no `TerminalSession`, no
 * `libtermux.so`). Android + Termux + Compose only; no other `:core` module (PLAN §3). Agent X.
 *
 * - [TerminalState]: the emulator and everything about it (feed, hold/release, grid mode,
 *   callbacks, observable modes). Lives where the stream lives; survives the view.
 * - [TerminalSurface] (Compose) / [OptioTerminalView] (View): renders a state; touch, keys, IME.
 * - [TerminalKeyBar]: iOS's extra keys + sticky ctrl/alt, sending through the state.
 * - [TerminalSizing], [StreamPolicy]: the pure Local rules (ports of iOS/web, with their tests).
 * - [TerminalTheme], [TerminalFonts], [TerminalKeys], [TerminalSamples].
 *
 * Pod session (the grid follows the phone; iOS `SessionTerminalView`):
 * ```
 * val terminal = remember { TerminalState() }                          // Fit
 * terminal.onInput = { bytes -> ws.send(bytes) }                         // binary = stdin
 * terminal.onGridSizeChanged = { g -> ws.sendJson("""{"type":"resize","cols":${g.cols},"rows":${g.rows}}""") }
 * // on open: terminal.naturalGrid?.let { resize(it) }; frames: binary → terminal.feed(bytes)
 * Column(Modifier.imePadding()) {
 *     TerminalSurface(terminal, Modifier.weight(1f))
 *     TerminalKeyBar(terminal, enabled = connected)
 * }
 * LaunchedEffect(Unit) { terminal.focus() }                               // iOS focuses sessions
 * ```
 *
 * Optio Local (one PTY, one grid: attaching never resizes it; iOS `LocalTerminalStream`):
 * ```
 * var mode: TerminalSizing.Mode = TerminalSizing.Mode.Unclaimed; var sent = emptyList<TerminalGrid>()
 * terminal.onInput = { bytes -> sendJson(input(String(bytes, UTF_8))) }
 * terminal.onInteraction = { if (mode != Owner) claim() }                 // tap, focus, a key: claim first
 * terminal.onGridSizeChanged = { g -> if (mode == Owner) sendResize(g) }  // rotation, keyboard
 * terminal.onNaturalGridChanged = { if (mode != Owner) announced?.let(::gridAnnounced) }
 * // connect: terminal.hold(); binary: if (pendingReset) terminal.reset(); terminal.feed(bytes)
 * // size frame: gridAnnounced(grid); terminal.release(suppressReplies = true)   // end of replay
 * // exit/error/close: terminal.release()
 * fun gridAnnounced(grid: TerminalGrid) {
 *     mode = TerminalSizing.onGridAnnounced(mode, grid, terminal.naturalGrid ?: TerminalGrid(0, 0), sent, recorded = dead)
 *     sent = TerminalSizing.ackSentGrid(sent, grid) ?: sent
 *     terminal.gridMode = mode.gridMode                                    // Passive → Fixed(grid): shrunk to fit
 * }
 * fun claim() { if (dead) return; mode = Owner; terminal.gridMode = TerminalGridMode.Fit
 *     if (terminal.naturalGrid != null) sendResize(terminal.grid) }        // sendResize pushes onto `sent`
 * TerminalSurface(terminal, readOnly = dead, inputMode = TerminalInputMode.Text)
 * ```
 * The debug playground's `PlaygroundLocalStream` is this recipe, working against a real daemon.
 */
package dev.optio.core.terminal
