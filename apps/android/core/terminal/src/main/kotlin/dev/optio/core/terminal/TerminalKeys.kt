package dev.optio.core.terminal

import android.view.KeyCharacterMap
import android.view.KeyEvent
import com.termux.terminal.KeyHandler

/** Something a key press sends to the terminal. Encoded by [TerminalKeys.encode]. */
sealed interface TerminalKey {
    /** A character: a latched Ctrl maps it to its control code, Alt prefixes ESC. */
    data class Char(val codePoint: Int) : TerminalKey

    /** Fixed bytes (e.g. `^C`): only Alt applies, as an ESC prefix. */
    class Bytes(val bytes: ByteArray) : TerminalKey {
        override fun equals(other: Any?): Boolean = other is Bytes && other.bytes.contentEquals(bytes)

        override fun hashCode(): Int = bytes.contentHashCode()

        override fun toString(): String = "Bytes(${bytes.joinToString(" ") { "%02x".format(it) }})"
    }

    /**
     * A special key by Android key code (arrows, Tab, Esc, Home/End, PgUp/PgDn, F-keys, …), encoded
     * by Termux's `KeyHandler` so modifiers and application cursor/keypad modes come out as xterm
     * sends them (`ESC [ 1 ; 5 A` for Ctrl+Up).
     */
    data class Special(val keyCode: Int) : TerminalKey
}

/**
 * Key → bytes, as a desktop terminal sends them. Pure apart from Termux's `KeyHandler` table, so it
 * is unit-testable; the view, the IME connection and the key bar all encode through here.
 */
object TerminalKeys {
    const val ESC: Byte = 0x1b

    /**
     * What Shift+Enter sends. A terminal collapses every Enter to CR, so an agent REPL can't tell
     * Shift+Enter (newline) from Enter (submit); ESC CR is what `claude /terminal-setup` teaches
     * iTerm2 / VS Code to send, and Claude Code reads it as "insert newline" (web `conn-state.ts`).
     */
    val SHIFT_ENTER: ByteArray = byteArrayOf(ESC, '\r'.code.toByte())

    /** Backspace: DEL, like xterm and every modern terminal. */
    val BACKSPACE: ByteArray = byteArrayOf(0x7f)

    val ENTER: ByteArray = byteArrayOf('\r'.code.toByte())

    /**
     * Ctrl+`codePoint` as a terminal sends it (Termux's `inputCodePoint` table): letters to 1–26,
     * space/2 → NUL, `[`/3 → ESC, `\`/4 → FS, `]`/5 → GS, `^`/6 → RS, `_`/7/`/` → US, 8 → DEL. Other
     * characters have no control form and pass through unchanged.
     */
    fun ctrlCodePoint(codePoint: Int): Int =
        when (codePoint) {
            in 'a'.code..'z'.code -> codePoint - 'a'.code + 1
            in 'A'.code..'Z'.code -> codePoint - 'A'.code + 1
            ' '.code, '2'.code -> 0
            '['.code, '3'.code -> 27
            '\\'.code, '4'.code -> 28
            ']'.code, '5'.code -> 29
            '^'.code, '6'.code -> 30
            '_'.code, '7'.code, '/'.code -> 31
            '8'.code -> 127
            else -> codePoint
        }

    /** One code point with optional Ctrl (control code) and Alt (ESC prefix), as UTF-8. */
    fun encodeCodePoint(codePoint: Int, ctrl: Boolean = false, alt: Boolean = false): ByteArray {
        var cp = if (ctrl) ctrlCodePoint(codePoint) else codePoint
        // Bluetooth keyboards send spacing modifier letters where a terminal wants ASCII.
        cp =
            when (cp) {
                0x02DC -> '~'.code
                0x02CB -> '`'.code
                0x02C6 -> '^'.code
                else -> cp
            }
        if (cp < 0 || cp > Character.MAX_CODE_POINT || cp in Character.MIN_SURROGATE.code..Character.MAX_SURROGATE.code) {
            return ByteArray(0)
        }
        val utf8 = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)
        return if (alt) byteArrayOf(ESC) + utf8 else utf8
    }

    /**
     * Encodes [key] with the given modifiers and terminal modes. Returns an empty array for a key
     * with nothing to send.
     */
    fun encode(
        key: TerminalKey,
        ctrl: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
        applicationCursor: Boolean = false,
        applicationKeypad: Boolean = false,
    ): ByteArray =
        when (key) {
            is TerminalKey.Char -> encodeCodePoint(key.codePoint, ctrl, alt)
            is TerminalKey.Bytes -> if (alt) byteArrayOf(ESC) + key.bytes else key.bytes.copyOf()
            is TerminalKey.Special -> {
                var mod = 0
                if (ctrl) mod = mod or KeyHandler.KEYMOD_CTRL
                if (alt) mod = mod or KeyHandler.KEYMOD_ALT
                if (shift) mod = mod or KeyHandler.KEYMOD_SHIFT
                KeyHandler.getCode(key.keyCode, mod, applicationCursor, applicationKeypad)
                    ?.toByteArray(Charsets.UTF_8)
                    ?: ByteArray(0)
            }
        }

    /**
     * Text typed on the soft keyboard, as the terminal should receive it: `\n` becomes CR (the enter
     * key of AOSP-derived keyboards commits "\n"), and C0 controls some keyboards emit for Ctrl input
     * are sent as their control codes. A latched Ctrl/Alt applies to the first code point only.
     */
    fun encodeTyped(text: CharSequence, ctrl: Boolean = false, alt: Boolean = false): ByteArray {
        val out = java.io.ByteArrayOutputStream(text.length + 2)
        var i = 0
        var first = true
        while (i < text.length) {
            val cp = Character.codePointAt(text, i)
            i += Character.charCount(cp)
            val mapped = if (cp == '\n'.code) '\r'.code else cp
            out.write(encodeCodePoint(mapped, ctrl && first, alt && first))
            first = false
        }
        return out.toByteArray()
    }
}

/**
 * A hardware (or IME-synthesised) key event → bytes: a port of Termux `TerminalView.onKeyDown`
 * without its client hooks. Keeps the pending dead-key accent between presses.
 */
internal class HardwareKeyEncoder {
    private var combiningAccent = 0

    /** True while a dead key waits for the next character (the view may want to redraw). */
    val hasPendingAccent: Boolean get() = combiningAccent != 0

    fun reset() {
        combiningAccent = 0
    }

    /**
     * Bytes for `event`, or null when it isn't a terminal key (let the system handle it). An empty
     * array means "consumed, nothing to send" (a dead key).
     */
    @Suppress("DEPRECATION") // ACTION_MULTIPLE text still arrives from some IMEs and devices.
    fun encode(
        event: KeyEvent,
        ctrlLatched: Boolean,
        altLatched: Boolean,
        applicationCursor: Boolean,
        applicationKeypad: Boolean,
    ): ByteArray? {
        val keyCode = event.keyCode
        if (event.action == KeyEvent.ACTION_MULTIPLE && keyCode == KeyEvent.KEYCODE_UNKNOWN) {
            return event.characters?.let { TerminalKeys.encodeTyped(it) }
        }
        val metaState = event.metaState
        val controlDown = event.isCtrlPressed || ctrlLatched
        val leftAltDown = (metaState and KeyEvent.META_ALT_LEFT_ON) != 0 || altLatched
        val shiftDown = event.isShiftPressed
        val rightAltDown = (metaState and KeyEvent.META_ALT_RIGHT_ON) != 0

        if ((keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) &&
            shiftDown && !controlDown && !event.isAltPressed && !altLatched && !event.isMetaPressed
        ) {
            return TerminalKeys.SHIFT_ENTER
        }

        var keyMod = 0
        if (controlDown) keyMod = keyMod or KeyHandler.KEYMOD_CTRL
        if (event.isAltPressed || leftAltDown) keyMod = keyMod or KeyHandler.KEYMOD_ALT
        if (shiftDown) keyMod = keyMod or KeyHandler.KEYMOD_SHIFT
        if (event.isNumLockOn) keyMod = keyMod or KeyHandler.KEYMOD_NUM_LOCK
        if (!event.isFunctionPressed) {
            KeyHandler.getCode(keyCode, keyMod, applicationCursor, applicationKeypad)?.let {
                return it.toByteArray(Charsets.UTF_8)
            }
        }

        // Ctrl is applied by us; left Alt becomes an ESC prefix; right Alt (AltGr) composes.
        var bitsToClear = KeyEvent.META_CTRL_MASK
        if (!rightAltDown) bitsToClear = bitsToClear or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        var effectiveMeta = metaState and bitsToClear.inv()
        if (shiftDown) effectiveMeta = effectiveMeta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        val result = event.getUnicodeChar(effectiveMeta)
        if (result == 0) return null

        if ((result and KeyCharacterMap.COMBINING_ACCENT) != 0) {
            // A dead key: remember it; a second dead key in a row writes the first one out.
            val out =
                if (combiningAccent != 0) TerminalKeys.encodeCodePoint(combiningAccent, controlDown, leftAltDown) else ByteArray(0)
            combiningAccent = result and KeyCharacterMap.COMBINING_ACCENT_MASK
            return out
        }
        var codePoint = result
        if (combiningAccent != 0) {
            val combined = KeyCharacterMap.getDeadChar(combiningAccent, codePoint)
            if (combined > 0) codePoint = combined
            combiningAccent = 0
        }
        return TerminalKeys.encodeCodePoint(codePoint, controlDown, leftAltDown)
    }
}
