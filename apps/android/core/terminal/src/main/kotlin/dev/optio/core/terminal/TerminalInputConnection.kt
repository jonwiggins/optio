package dev.optio.core.terminal

import android.text.Selection
import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputMethodManager
import kotlin.math.max
import kotlin.math.min

/**
 * The soft keyboard → terminal bytes.
 *
 * - [TerminalInputMode.Text] / [TerminalInputMode.Raw] (Termux's approach): the editable only ever
 *   holds the text being composed and is cleared after every commit, so with nothing before the
 *   cursor keyboards send Backspace as a DEL key event, encoded like a hardware key. Text an IME
 *   composes (CJK) is shown at the cursor and sent when committed.
 * - [TerminalInputMode.Prose]: the editable mirrors the line typed through the keyboard since the
 *   last Enter (or other key), so autocorrect, suggestions, glide typing and "undo autocorrect" can
 *   edit it like a text field. After every edit (or batch of edits) the terminal is brought to the
 *   same text with backspaces from the end plus the new tail, and the IME is told where the cursor
 *   is. A TUI sees every keystroke as it's typed. Gboard, for one, commits each letter and later
 *   re-composes the word (`setComposingRegion`) to correct it; that only works against a mirror.
 *
 * Enter arrives as a key event, a committed "\n" or an editor action; all three send CR. A commit
 * with a line break in it (the keyboard's clipboard) is pasted, so bracketed paste applies.
 *
 * `adb shell setprop log.tag.OptioTerminalIme DEBUG` traces every call the keyboard makes.
 */
internal class TerminalInputConnection(
    private val view: OptioTerminalView,
    private val mode: TerminalInputMode,
) : BaseInputConnection(view, true) {
    private val live = mode == TerminalInputMode.Prose

    /** Prose: the editable's text as the terminal has it (the cursor sits at its end). */
    private var synced = ""
    private var batchDepth = 0
    private var consumedDelDown = false
    private val trace = Log.isLoggable(TAG, Log.DEBUG)

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        log("commitText(\"$text\", $newCursorPosition)")
        if (live) {
            super.commitText(text ?: "", newCursorPosition)
            afterEdit()
            return true
        }
        val s = text?.toString().orEmpty()
        if (isPaste(s)) view.imeInput { view.pasteText(s) } else view.imeInput { view.typeText(s) }
        clearHeld()
        return true
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        log("setComposingText(\"$text\", $newCursorPosition)")
        super.setComposingText(text ?: "", newCursorPosition)
        if (live) afterEdit() else view.setComposing(text?.toString().orEmpty())
        return true
    }

    override fun finishComposingText(): Boolean {
        log("finishComposingText()")
        if (live) {
            super.finishComposingText()
            afterEdit()
            return true
        }
        val composing = editable?.toString().orEmpty()
        super.finishComposingText()
        if (composing.isNotEmpty()) view.imeInput { view.typeText(composing) }
        clearHeld()
        return true
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        log("deleteSurroundingText($beforeLength, $afterLength)")
        val beyond = beginDelete(beforeLength)
        val done = super.deleteSurroundingText(beforeLength, afterLength)
        endDelete(beyond)
        return done
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        log("deleteSurroundingTextInCodePoints($beforeLength, $afterLength)")
        val beyond = beginDelete(beforeLength)
        val done = super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
        endDelete(beyond)
        return done
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
        log("setComposingRegion($start, $end)")
        val done = super.setComposingRegion(start, end)
        if (live) afterEdit()
        return done
    }

    override fun setSelection(start: Int, end: Int): Boolean {
        log("setSelection($start, $end)")
        val done = super.setSelection(start, end)
        if (live) afterEdit()
        return done
    }

    override fun beginBatchEdit(): Boolean {
        batchDepth++
        return super.beginBatchEdit()
    }

    override fun endBatchEdit(): Boolean {
        batchDepth = max(0, batchDepth - 1)
        val more = super.endBatchEdit()
        if (live && batchDepth == 0) afterEdit()
        return more
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
        log("sendKeyEvent(${KeyEvent.keyCodeToString(event.keyCode)} action=${event.action})")
        if (live) {
            val content = editable
            val cursor = content?.let { Selection.getSelectionEnd(it) } ?: 0
            when {
                // Backspace over mirrored text: delete it in the mirror; the sync sends the DEL.
                event.keyCode == KeyEvent.KEYCODE_DEL && event.action == KeyEvent.ACTION_DOWN && content != null && cursor > 0 -> {
                    val start = Character.offsetByCodePoints(content, cursor, -1)
                    content.delete(start, cursor)
                    consumedDelDown = true
                    afterEdit()
                    return true
                }
                event.keyCode == KeyEvent.KEYCODE_DEL && event.action == KeyEvent.ACTION_UP && consumedDelDown -> {
                    consumedDelDown = false
                    return true
                }
            }
        }
        // Enter, arrows, Tab…: the view encodes the key, and any key outside the text path starts
        // a new line for the mirror (the view resets it when the key lands).
        return super.sendKeyEvent(event)
    }

    override fun performEditorAction(actionCode: Int): Boolean {
        log("performEditorAction($actionCode)")
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

    /** Input reached the terminal some other way (a key, the key bar, a paste): the mirror's line is over. */
    fun resetLine() {
        if (!live) return
        val content = editable
        if (content.isNullOrEmpty() && synced.isEmpty()) return
        content?.clear()
        synced = ""
        reportSelection()
    }

    // region Prose: the mirror

    /** Brings the terminal from [synced] to the editable's text: backspaces from the end, then the new tail. */
    private fun afterEdit() {
        if (batchDepth > 0) return
        val content = editable ?: return
        val now = content.toString()
        if (now != synced) {
            val old = synced
            synced = now
            var common = 0
            val limit = min(old.length, now.length)
            while (common < limit && old[common] == now[common]) common++
            if (common > 0 && Character.isHighSurrogate(old[common - 1])) common-- // don't split a pair
            val erase = old.codePointCount(common, old.length)
            val tail = now.substring(common)
            log("sync: erase $erase, type \"$tail\"")
            view.imeInput {
                if (erase > 0) view.sendBackspaces(erase)
                when {
                    tail.isEmpty() -> {}
                    isPaste(tail) -> view.pasteText(tail)
                    else -> view.typeText(tail)
                }
            }
            // A line break ends the line; a latched modifier changed what the terminal got.
            if (tail.any { it == '\n' || it == '\r' } || view.consumedLatch) {
                view.consumedLatch = false
                content.clear()
                synced = ""
            } else if (now.length > MAX_MIRROR) {
                content.delete(0, now.length - KEEP_MIRROR)
                synced = content.toString()
            }
        }
        reportSelection()
    }

    /**
     * Before a deletion: how many of the [beforeLength] characters lie before the mirror's start
     * (text typed before it). Held modes: nothing before the cursor is in the editable, so all of
     * it was sent already; send the backspaces now.
     */
    private fun beginDelete(beforeLength: Int): Int {
        if (!live) {
            if (beforeLength > 0) view.imeInput { view.sendBackspaces(beforeLength) }
            return 0
        }
        val content = editable ?: return 0
        var anchor = Selection.getSelectionStart(content)
        val composingStart = getComposingSpanStart(content)
        if (composingStart in 0 until anchor) anchor = composingStart
        batchDepth++
        return max(0, beforeLength - max(anchor, 0))
    }

    private fun endDelete(beyond: Int) {
        if (!live) return
        batchDepth--
        val content = editable ?: return
        if (beyond <= 0) {
            afterEdit()
            return
        }
        // It reached older text: rewrite the whole mirrored line around the deletion.
        val old = synced
        synced = content.toString()
        view.imeInput {
            view.sendBackspaces(old.codePointCount(0, old.length) + beyond)
            if (synced.isNotEmpty()) view.typeText(synced)
        }
        reportSelection()
    }

    private fun reportSelection() {
        val content = editable ?: return
        val imm = view.context.getSystemService(InputMethodManager::class.java) ?: return
        imm.updateSelection(
            view,
            Selection.getSelectionStart(content),
            Selection.getSelectionEnd(content),
            getComposingSpanStart(content),
            getComposingSpanEnd(content),
        )
    }

    // endregion

    private fun clearHeld() {
        editable?.clear()
        view.setComposing("")
    }

    private fun isPaste(s: String): Boolean = s.length > 1 && s.any { it == '\n' || it == '\r' }

    private fun log(msg: String) {
        if (trace) Log.d(TAG, "$msg | synced=\"$synced\" editable=\"${editable ?: ""}\"")
    }

    private companion object {
        const val TAG = "OptioTerminalIme"

        /** Mirror at most this much of a long line; trim to [KEEP_MIRROR] from the start. */
        const val MAX_MIRROR = 1024
        const val KEEP_MIRROR = 256
    }
}
