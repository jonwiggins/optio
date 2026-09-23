package dev.optio.core.terminal.playground

import dev.optio.core.terminal.TerminalState

/**
 * A tiny local "shell" for the playground: echoes what you type, handles Enter and Backspace, and
 * prints control characters and escape sequences visibly (cyan `␛[A`, magenta `^C`), so the
 * keyboard, the key bar and wheel reports can all be checked on screen without a server.
 */
internal class EchoLoop(private val terminal: TerminalState) {
    private val line = StringBuilder()

    fun start() {
        terminal.feed(
            "\u001b[1mEcho loop\u001b[0m: type on the keyboard or the key bar.\r\n" +
                "Keys that send escape sequences show in \u001b[36mcyan\u001b[0m, control keys in \u001b[35mmagenta\u001b[0m.\r\n\r\n",
        )
        prompt()
    }

    private fun prompt() = terminal.feed("\u001b[1;32mecho\u001b[0m:\u001b[1;34m~\u001b[0m$ ")

    fun onInput(bytes: ByteArray) {
        val s = String(bytes, Charsets.UTF_8)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '\r' -> {
                    terminal.feed("\r\n")
                    if (line.isNotEmpty()) terminal.feed("\u001b[2myou typed: ${line}\u001b[0m\r\n")
                    line.clear()
                    prompt()
                }
                c == '\u007f' || c == '\b' -> {
                    if (line.isNotEmpty()) {
                        val cp = line.codePointBefore(line.length)
                        line.setLength(line.length - Character.charCount(cp))
                        val wide = com.termux.terminal.WcWidth.width(cp) == 2
                        terminal.feed(if (wide) "\b\b  \b\b" else "\b \b")
                    }
                }
                c == '\u001b' -> {
                    val end = sequenceEnd(s, i)
                    terminal.feed("\u001b[36m␛${s.substring(i + 1, end)}\u001b[0m")
                    i = end
                    continue
                }
                c < ' ' -> terminal.feed("\u001b[35m^${(c.code + 64).toChar()}\u001b[0m")
                else -> {
                    line.append(c)
                    terminal.feed(c.toString())
                }
            }
            i++
        }
    }

    /** End (exclusive) of the escape sequence starting at [start]: CSI to its final byte, SS3 + 1, else ESC + 1. */
    private fun sequenceEnd(s: String, start: Int): Int {
        if (start + 1 >= s.length) return s.length
        return when (s[start + 1]) {
            '[' -> {
                var j = start + 2
                while (j < s.length && s[j].code !in 0x40..0x7E) j++
                minOf(j + 1, s.length)
            }
            'O' -> minOf(start + 3, s.length)
            else -> start + 2
        }
    }
}
