package dev.optio.core.terminal

import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import kotlin.math.min

/**
 * The soft keyboard → terminal bytes. A terminal has no editable text the IME could inspect, so the
 * editable only ever holds the word being composed and is cleared after every commit (Termux's
 * approach); with nothing before the cursor, keyboards send Backspace as a DEL key event, which the
 * view encodes like a hardware key.
 *
 * - [TerminalInputMode.Text] / [TerminalInputMode.Raw]: committed text is sent as typed. Text an
 *   IME composes (CJK) is shown at the cursor and sent when it is committed.
 * - [TerminalInputMode.Prose]: the composing word is sent live and corrected with backspaces as the
 *   keyboard revises it (autocorrect, suggestions, glide typing), so a TUI sees every keystroke.
 *
 * Enter arrives as a key event, a committed "\n" or an editor action; all three send CR. A commit
 * with a line break in it (the keyboard's clipboard) is pasted, so bracketed paste applies.
 */
internal class TerminalInputConnection(
    private val view: OptioTerminalView,
    private val mode: TerminalInputMode,
) : BaseInputConnection(view, true) {
    /** Prose: the composing text the terminal has already received. */
    private var sentComposing = ""

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        val s = text?.toString().orEmpty()
        when {
            mode == TerminalInputMode.Prose && sentComposing.isNotEmpty() -> replaceComposing(s)
            isPaste(s) -> view.pasteText(s)
            else -> view.typeText(s)
        }
        endComposing()
        return true
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        super.setComposingText(text, newCursorPosition)
        val s = text?.toString().orEmpty()
        if (mode == TerminalInputMode.Prose) {
            replaceComposing(s)
            sentComposing = s
        } else {
            view.setComposing(s)
        }
        return true
    }

    override fun finishComposingText(): Boolean {
        val composing = editable?.toString().orEmpty()
        super.finishComposingText()
        if (mode != TerminalInputMode.Prose && composing.isNotEmpty()) view.typeText(composing)
        endComposing()
        return true
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        eraseBeforeComposing(beforeLength)
        return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        eraseBeforeComposing(beforeLength)
        return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }

    override fun performEditorAction(actionCode: Int): Boolean {
        view.sendEnter()
        return true
    }

    override fun performContextMenuAction(id: Int): Boolean {
        when (id) {
            android.R.id.paste, android.R.id.pasteAsPlainText -> view.pasteFromClipboard()
            android.R.id.selectAll -> view.state?.selectAll()
            android.R.id.copy -> view.copySelection()
            else -> return super.performContextMenuAction(id)
        }
        return true
    }

    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? = null

    override fun closeConnection() {
        finishComposingText()
        super.closeConnection()
    }

    /**
     * Text before the cursor that the IME deletes was already sent: erase it in the terminal. In
     * prose mode the live composing word sits after it, so take the word off, delete, and retype it.
     */
    private fun eraseBeforeComposing(count: Int) {
        if (count <= 0) return
        if (mode == TerminalInputMode.Prose && sentComposing.isNotEmpty()) {
            view.sendBackspaces(sentComposing.codePointCount(0, sentComposing.length) + count)
            view.typeText(sentComposing)
        } else {
            view.sendBackspaces(count)
        }
    }

    /** Prose: turns the composing text the terminal has into [new] with backspaces and the new tail. */
    private fun replaceComposing(new: String) {
        val old = sentComposing
        var common = 0
        val limit = min(old.length, new.length)
        while (common < limit && old[common] == new[common]) common++
        if (common > 0 && Character.isHighSurrogate(old[common - 1])) common-- // don't split a pair
        val erase = old.codePointCount(common, old.length)
        if (erase > 0) view.sendBackspaces(erase)
        val tail = new.substring(common)
        if (tail.isNotEmpty()) {
            if (isPaste(tail)) view.pasteText(tail) else view.typeText(tail)
        }
    }

    private fun endComposing() {
        sentComposing = ""
        editable?.clear()
        view.setComposing("")
    }

    private fun isPaste(s: String): Boolean = s.length > 1 && s.any { it == '\n' || it == '\r' }
}
