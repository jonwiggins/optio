package dev.optio.feature.local.transcript

import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.feature.local.api.LocalTranscriptPage
import dev.optio.feature.local.api.TRANSCRIPT_PAGE
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * A terminal's stored conversation: everything at start (paged), then, while live, only the
 * entries past the last seq every few seconds. A port of iOS `LocalTranscriptModel` (the web's
 * `use-transcript.ts`). [State.loaded] flips once the first fetch settles, so the screen can pick
 * its default face (transcript vs. screen) without a flash of the wrong one.
 *
 * [fetch] is `GET /api/local/terminals/:id/transcript?after=&limit=`. Runs in [scope] (the
 * screen's ViewModel); [pause] / [resume] follow the screen being visible.
 */
class LocalTranscriptModel(
    private val scope: CoroutineScope,
    private val fetch: suspend (after: Long, limit: Int) -> LocalTranscriptPage,
    private val livePoll: Duration = LIVE_POLL,
    private val pageSize: Int = TRANSCRIPT_PAGE,
) {
    data class State(
        val entries: List<LocalTranscriptEntry> = emptyList(),
        val loaded: Boolean = false,
    ) {
        val hasEntries: Boolean get() = entries.isNotEmpty()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var lastSeq = 0L
    private var inflight = false
    private var live = false
    private var paused = false
    private var started = false
    private var loadJob: Job? = null
    private var pollJob: Job? = null

    /** Fetches everything stored, then keeps polling while [live]. */
    fun start(live: Boolean) {
        this.live = live
        started = true
        loadJob?.cancel()
        loadJob =
            scope.launch {
                val all = ArrayList<LocalTranscriptEntry>()
                try {
                    var after = 0L
                    while (isActive) {
                        val page = fetch(after, pageSize)
                        all += page.entries
                        if (page.complete || page.entries.isEmpty()) break
                        after = page.entries.last().seq.toLong()
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // No transcript (an older row, a non-agent session): the screen stands in.
                }
                lastSeq = all.lastOrNull()?.seq?.toLong() ?: 0L
                _state.value = State(entries = all, loaded = true)
                restartPolling()
            }
    }

    /**
     * The session ended (or came back): stop or start the live poll. A session that just ended gets
     * one extra fetch: the daemon flushes the final turn right before `exit`, after the last poll
     * may have run.
     */
    fun setLive(live: Boolean) {
        if (this.live == live) return
        this.live = live
        if (_state.value.loaded) restartPolling()
    }

    /** The screen went away (another tab, the app in the background): stop polling. */
    fun pause() {
        paused = true
        pollJob?.cancel()
        pollJob = null
    }

    /** The screen is back: catch up at once, then poll again while live. */
    fun resume() {
        if (!paused) return
        paused = false
        if (_state.value.loaded) {
            scope.launch { fetchMore() }
            restartPolling()
        }
    }

    /** Fetch what's new right now (after a message was sent, on a `local:changed` nudge). */
    fun poke() {
        if (!started || !_state.value.loaded) return
        scope.launch { fetchMore() }
    }

    fun stop() {
        loadJob?.cancel()
        pollJob?.cancel()
        loadJob = null
        pollJob = null
    }

    private fun restartPolling() {
        pollJob?.cancel()
        pollJob = null
        if (paused) return
        pollJob =
            if (!live) {
                scope.launch { fetchMore() }
            } else {
                scope.launch {
                    while (isActive) {
                        delay(livePoll)
                        fetchMore()
                    }
                }
            }
    }

    /** Entries past the last seq. */
    private suspend fun fetchMore() {
        if (inflight) return
        inflight = true
        try {
            val page = fetch(lastSeq, pageSize)
            // Keep only what's new, in case two fetches overlapped a page.
            val fresh = page.entries.filter { it.seq.toLong() > lastSeq }
            if (fresh.isEmpty()) return
            lastSeq = fresh.last().seq.toLong()
            _state.update { it.copy(entries = it.entries + fresh) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Transient: the next tick retries.
        } finally {
            inflight = false
        }
    }

    companion object {
        /** How often a live session's transcript is polled (web and iOS: 4 s). */
        val LIVE_POLL: Duration = 4.seconds
    }
}
