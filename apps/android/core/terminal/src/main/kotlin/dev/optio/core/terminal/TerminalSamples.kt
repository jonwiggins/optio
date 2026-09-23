package dev.optio.core.terminal

import java.util.Locale

/**
 * Canned terminal output: what the screenshot tests and the debug playground play, and what a
 * feature module can feed a [TerminalState] for its own previews. Each sample is plain ANSI as a
 * program would write it; the grid-dependent ones draw with absolute cursor moves, the way a TUI
 * repaints.
 */
object TerminalSamples {
    private const val ESC = "\u001b"
    private const val CSI = "$ESC["
    private const val RESET = "${CSI}0m"

    /** A sample by id, rendered for the grid it will be shown at. */
    class Sample(val id: String, val title: String, val render: (TerminalGrid) -> String)

    val all: List<Sample> =
        listOf(
            Sample("colors", "Colours") { colors() },
            Sample("unicode", "Box, CJK, emoji") { unicode() },
            Sample("shell", "Shell + scrollback") { shell() },
            Sample("claude", "Claude-like TUI") { claudeCode(it.cols, it.rows) },
            Sample("htop", "Alt-screen redraw") { altScreen(it.cols, it.rows) },
            Sample("mouse", "Mouse tracking") { mouseTracking() },
        )

    fun byId(id: String): Sample? = all.firstOrNull { it.id == id }

    /** 16 colours as text and swatches, the 256-colour cube and greys, a truecolour ramp, SGR attributes. */
    fun colors(): String =
        buildString {
            line("${CSI}1mColours & attributes$RESET")
            line("")
            append("  ")
            for (c in 0..7) append("${CSI}4${c}m   ")
            line("$RESET normal")
            append("  ")
            for (c in 0..7) append("${CSI}10${c}m   ")
            line("$RESET bright")
            val names = listOf("black", "red", "green", "yellow", "blue", "magenta", "cyan", "white")
            append("  ")
            for (c in 1..6) append("${CSI}3${c}m${names[c]}$RESET ")
            line("")
            append("  ")
            for (c in 1..6) append("${CSI}9${c}m${names[c]}$RESET ")
            line("")
            line("")
            line("  256-colour cube and greys")
            for (block in 0 until 6) {
                append("  ")
                for (i in 0 until 36) append("${CSI}48;5;${16 + block * 36 + i}m ")
                line(RESET)
            }
            append("  ")
            for (i in 232..255) append("${CSI}48;5;${i}m ")
            line(RESET)
            line("")
            line("  Truecolour")
            append("  ")
            for (i in 0 until 48) {
                val (r, g, b) = hue(i / 48.0)
                append("${CSI}48;2;$r;$g;${b}m ")
            }
            line(RESET)
            line("")
            line("  ${CSI}1mbold$RESET ${CSI}2mdim$RESET ${CSI}3mitalic$RESET ${CSI}4munderline$RESET ${CSI}7minverse$RESET ${CSI}9mstrike$RESET")
            line("  ${CSI}1;31mbold red$RESET ${CSI}2;32mdim green$RESET ${CSI}38;2;215;119;87mclaude orange$RESET ${CSI}38;5;141mpurple 141$RESET")
        }

    /** Box drawing, block elements, braille, wide CJK and emoji (with bars to check alignment), accents. */
    fun unicode(): String =
        buildString {
            line("${CSI}1mUnicode$RESET")
            line("")
            line("  ┌─────┬─────┐  ╭─────────╮  ╔═══╗")
            line("  │ one │ two │  │ rounded │  ║ ≡ ║")
            line("  ├─────┼─────┤  ╰─────────╯  ╚═══╝")
            line("  └─────┴─────┘  ━━━━━━━━━━━  ┃ ┃ ┃")
            line("")
            line("  blocks   ▁▂▃▄▅▆▇█ ░▒▓█ ▏▎▍▌▋▊▉")
            line("  braille  ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
            line("  wide     |漢字|日本語|한국어|")
            line("  narrow   |abcd|efghij|klmnop|")
            line("  emoji    |🚀|✅|🎉|⭐|")
            line("  narrow   |ab|cd|ef|gh|")
            line("  symbols  ⏺ ⎿ ✻ ⏵⏵ ❯ ✓ ✗ → ← ↑ ↓ •")
            line("  accents  é ñ ü é ä ﬁ")
        }

    /** A shell session: a coloured prompt, `ls`, `git log`, and enough lines to scroll back through. */
    fun shell(lines: Int = 120): String =
        buildString {
            val prompt = "${CSI}1;32mjon@laptop$RESET:${CSI}1;34m~/repos/optio$RESET ${CSI}33m(main)$RESET$ "
            line("${prompt}ls -la apps")
            line("total 0")
            val dirs = listOf("android", "api", "cli", "ios", "web")
            line("drwxr-xr-x   8 jon  staff   256 Sep 22 17:24 ${CSI}1;34m.$RESET")
            line("drwxr-xr-x  24 jon  staff   768 Sep 22 17:24 ${CSI}1;34m..$RESET")
            for (d in dirs) line("drwxr-xr-x  14 jon  staff   448 Sep 22 17:24 ${CSI}1;34m$d$RESET")
            line("${prompt}git log --oneline -4")
            line("${CSI}33mef3e6727$RESET Merge pull request #617 from jonwiggins/feat/run-names-and-token-validation")
            line("${CSI}33m1028f49b$RESET test(web): scope the prompt chip click, cover the run-name field")
            line("${CSI}33m31737d89$RESET fix(auth): catch revoked Claude tokens the usage endpoint only 429s")
            line("${CSI}33m07b92d88$RESET feat(work): name each run from the trigger's params")
            line("${prompt}seq -f 'line %g' $lines")
            for (i in 1..lines) line("line $i")
            append(prompt)
        }

    /**
     * A Claude-Code-like full-screen TUI at `cols` × `rows`: the alternate screen with mouse tracking
     * (SGR) and bracketed paste on and the cursor hidden, a welcome panel, a transcript with tool
     * calls and a diff, a spinner, and the prompt box and mode line pinned to the bottom. Drawn inside
     * a synchronized update, as Claude Code does.
     */
    fun claudeCode(cols: Int, rows: Int): String =
        buildString {
            val w = cols.coerceAtLeast(20)
            val orange = "${CSI}38;2;215;119;87m"
            val green = "${CSI}38;2;78;186;101m"
            val grey = "${CSI}38;5;244m"
            val dim = "${CSI}2m"
            val bold = "${CSI}1m"
            val purple = "${CSI}38;2;175;135;255m"
            append("$CSI?1049h$CSI?25l$CSI?1000h$CSI?1006h$CSI?2004h$CSI?2026h")
            append("${CSI}H${CSI}2J")
            var row = 1
            fun at(r: Int, text: String) {
                if (r in 1..rows) append("$CSI$r;1H${CSI}2K$text$RESET")
            }
            val inner = w - 2
            // Welcome panel.
            fun panel(content: String) = "$orange│$RESET${fit(content, inner, fill = true)}$RESET$orange│"
            at(row++, "$orange╭${"─".repeat(inner)}╮")
            at(row++, panel(" ${orange}✻$RESET ${bold}Welcome to Claude Code!"))
            at(row++, panel(""))
            at(row++, panel("$grey   /help for help, /status for your setup"))
            at(row++, panel("$grey   cwd: ~/repos/optio"))
            at(row++, "$orange╰${"─".repeat(inner)}╯")
            row++
            val transcript =
                listOf(
                    "$grey> ${RESET}Fix the flaky reconnect test in stream-policy" to 2,
                    "" to 0,
                    "$RESET⏺ I'll read the stream policy tests first." to 2,
                    "" to 0,
                    "$green⏺ ${RESET}${bold}Read$RESET(apps/web/src/components/local/stream-policy.test.ts)" to 2,
                    "$grey  ⎿  Read 68 lines" to 5,
                    "" to 0,
                    "$green⏺ ${RESET}${bold}Update$RESET(apps/web/src/components/local/stream-policy.ts)" to 2,
                    "$grey  ⎿  Updated with 1 addition and 1 removal" to 5,
                    "${CSI}38;2;250;250;250;48;2;92;34;42m      45 -  if (opts.terminalDead) return stop;" to -1,
                    "${CSI}38;2;250;250;250;48;2;30;77;42m      45 +  if (opts.terminalDead) return { kind: \"stop\" };" to -1,
                    "" to 0,
                    "$RESET⏺ The reconnect test passes now. Opening a PR." to 2,
                )
            val bottomStart = rows - 5 // spinner, blank, box ×3, mode line
            for ((text, indent) in transcript) {
                if (row >= bottomStart) break
                if (indent < 0) {
                    // A diff line: fills the width with its background.
                    at(row++, fit(text, w, fill = true))
                } else {
                    at(row++, fit(text, w))
                }
            }
            at(rows - 5, fit("$orange✻ Flibbertigibbeting… $grey(12s · ↑ 1.2k tokens · esc to interrupt)", w))
            at(rows - 3, "$grey╭${"─".repeat(inner)}╮")
            at(rows - 2, "$grey│$RESET > ${CSI}7m $RESET${" ".repeat((inner - 4).coerceAtLeast(0))}$grey│")
            at(rows - 1, "$grey╰${"─".repeat(inner)}╯")
            at(rows, fit("  $purple⏵⏵ accept edits on$RESET$dim (shift+tab to cycle)", w))
            append("$CSI?2026l")
        }

    /**
     * An htop-like alternate-screen program at `cols` × `rows`, repainted with absolute moves.
     * Successive [frame]s change the numbers (the playground animates them).
     */
    fun altScreen(cols: Int, rows: Int, frame: Int = 0): String =
        buildString {
            val w = cols.coerceAtLeast(30)
            append("$CSI?1049h$CSI?25l") // no-ops once the program is up
            if (frame == 0) append("${CSI}H${CSI}2J")
            fun at(r: Int, text: String) {
                if (r in 1..rows) append("$CSI$r;1H${CSI}2K$text$RESET")
            }
            val cpu = listOf(47.2, 18.4, 63.9, 5.1).map { ((it + frame * 7.3) % 100.0) }
            val bar = (w - 16).coerceAtLeast(10)
            cpu.forEachIndexed { i, pct ->
                val filled = (bar * pct / 100).toInt()
                at(i + 1, "  ${CSI}36m${i + 1}$RESET [${CSI}32m${"|".repeat(filled)}$RESET${" ".repeat(bar - filled)}${"%5.1f".format(Locale.US, pct)}%]")
            }
            at(6, "  ${CSI}36mTasks:$RESET ${CSI}1m${312 + frame}$RESET, 1204 thr; ${CSI}32m3 running")
            at(7, "  ${CSI}36mLoad average:$RESET 2.41 1.98 1.77")
            at(9, "${CSI}30;42m${fit("    PID USER     CPU% MEM%   TIME+  Command", w, fill = true)}")
            val procs =
                listOf(
                    "node apps/api/src/index.ts", "claude", "optio local up", "kube-apiserver", "postgres: optio",
                    "redis-server *:6379", "gradle daemon", "qemu-system-aarch64", "zsh", "less --mouse README.md",
                )
            procs.forEachIndexed { i, cmd ->
                val pid = 4211 + i * 37
                val pct = ((13.7 * (i + 1) + frame * 3.1) % 60.0)
                val color = if (i == 0) "${CSI}1m" else ""
                at(10 + i, fit("$color  %5d jon     %4.1f  %3.1f  1%d:0%d.33  %s".format(Locale.US, pid, pct, pct / 8, i, frame % 10, cmd), w))
            }
            val keys = listOf("F1" to "Help", "F2" to "Setup", "F3" to "Search", "F5" to "Tree", "F9" to "Kill", "F10" to "Quit")
            at(rows, keys.joinToString("") { (k, v) -> "$RESET$k${CSI}30;46m$v$RESET" }.let { fit(it, w) })
        }

    /** Turns on mouse tracking (SGR) on the alternate screen and says what a drag now does. */
    fun mouseTracking(): String =
        buildString {
            append("$CSI?1049h${CSI}H${CSI}2J$CSI?1000h$CSI?1006h")
            line("${CSI}1mMouse tracking is on$RESET (DECSET 1000 + 1006, SGR).")
            line("")
            line("A vertical drag now sends wheel reports")
            line("${CSI}36mESC [ < 64 ; col ; row M$RESET (up) or 65 (down)")
            line("instead of scrolling the scrollback.")
            line("")
            line("Play another sample to leave this screen.")
        }

    private fun StringBuilder.line(s: String) {
        append(s)
        append("\r\n")
    }

    /**
     * Clips an SGR-coloured line to [width] visible columns (every visible character here is one
     * column wide), padding with spaces when [fill] so a background runs to the edge.
     */
    private fun fit(text: String, width: Int, fill: Boolean = false): String {
        val out = StringBuilder()
        var visible = 0
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '\u001b') {
                val end = text.indexOf('m', i)
                if (end < 0) break
                out.append(text, i, end + 1)
                i = end + 1
                continue
            }
            if (visible >= width) {
                i++
                continue
            }
            val cp = text.codePointAt(i)
            out.appendCodePoint(cp)
            visible++
            i += Character.charCount(cp)
        }
        if (fill && visible < width) out.append(" ".repeat(width - visible))
        return out.toString()
    }

    private fun hue(t: Double): Triple<Int, Int, Int> {
        val h = t * 6
        val x = 1 - kotlin.math.abs(h % 2 - 1)
        val (r, g, b) =
            when (h.toInt()) {
                0 -> Triple(1.0, x, 0.0)
                1 -> Triple(x, 1.0, 0.0)
                2 -> Triple(0.0, 1.0, x)
                3 -> Triple(0.0, x, 1.0)
                4 -> Triple(x, 0.0, 1.0)
                else -> Triple(1.0, 0.0, x)
            }
        return Triple((r * 220).toInt() + 20, (g * 220).toInt() + 20, (b * 220).toInt() + 20)
    }
}
