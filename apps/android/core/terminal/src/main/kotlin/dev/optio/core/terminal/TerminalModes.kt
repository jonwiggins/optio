package dev.optio.core.terminal

import androidx.compose.runtime.Immutable

/** How the terminal's cols × rows are decided. */
@Immutable
sealed interface TerminalGridMode {
    /**
     * The grid follows the view: cols × rows from its size and the base font, reported through
     * [TerminalState.onGridSizeChanged] so the owner can resize the PTY (pod sessions; a Local
     * terminal this phone has claimed or nobody has).
     */
    data object Fit : TerminalGridMode

    /**
     * Someone else owns the PTY size (the daemon announced it): render exactly [cols] × [rows],
     * scaled to fit the view (the font shrinks down to a minimum, or grows up to a cap on a wide
     * screen), and never resize the PTY. A grid clamped at the minimum font pans. iOS: "Sized for
     * another device".
     */
    data class Fixed(val cols: Int, val rows: Int) : TerminalGridMode {
        constructor(grid: TerminalGrid) : this(grid.cols, grid.rows)

        val grid: TerminalGrid get() = TerminalGrid(cols, rows)
    }
}

/** The grid mode a Local viewer in `this` sizing mode renders: its own fit, or the owner's grid. */
val TerminalSizing.Mode.gridMode: TerminalGridMode
    get() =
        when (this) {
            TerminalSizing.Mode.Unclaimed, TerminalSizing.Mode.Owner -> TerminalGridMode.Fit
            is TerminalSizing.Mode.Passive -> TerminalGridMode.Fixed(grid)
        }

/** How the soft keyboard talks to the terminal. */
enum class TerminalInputMode {
    /**
     * A text field with suggestions off (`visiblePassword|noSuggestions`): no autocorrect, no
     * suggestion strip, each key committed as typed. What works best with Gboard for a shell or TUI,
     * and the default. An IME that composes anyway (CJK) has its composing text shown at the cursor
     * and sent when committed.
     */
    Text,

    /**
     * `TYPE_NULL`: the keyboard sends key events, like a hardware keyboard (Termux's default). The
     * rawest option: some IMEs lose features (voice, glide typing) in this mode.
     */
    Raw,

    /**
     * Autocorrect, suggestions and glide typing on, for writing prose to an agent (iOS keeps
     * autocorrect for Local prompts). The word being composed is sent live and corrected with
     * backspaces, so a TUI sees every keystroke (Claude Code's `/` and `@` menus still pop up).
     */
    Prose,
}
