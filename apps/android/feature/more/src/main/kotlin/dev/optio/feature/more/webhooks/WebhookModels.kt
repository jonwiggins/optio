package dev.optio.feature.more.webhooks

import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.WebhookCreateInput
import dev.optio.feature.more.api.WebhookDeliveryRow
import dev.optio.feature.more.api.WebhookRow
import dev.optio.feature.more.api.createWebhook
import dev.optio.feature.more.api.deleteWebhook
import dev.optio.feature.more.api.getWebhook
import dev.optio.feature.more.api.listWebhookDeliveries
import dev.optio.feature.more.api.listWebhooks
import dev.optio.feature.more.api.setWebhookActive
import dev.optio.feature.more.api.testWebhook
import dev.optio.feature.more.ui.MoreWebhookEvents
import dev.optio.feature.more.ui.NoticeViewModel
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The toast after a test delivery (iOS: "Delivered (HTTP 200)" / "Failed: …"). */
internal fun deliveryNotice(delivery: WebhookDeliveryRow): Pair<String, Tone> {
    val code = delivery.statusCode?.toString() ?: "?"
    return if (delivery.success == true) {
        "Delivered (HTTP $code)" to Tone.SUCCESS
    } else {
        "Failed: ${delivery.error ?: "HTTP $code"}" to Tone.DANGER
    }
}

/** The events line of a row: the first three, then "+N" (iOS `WebhooksListView.row`). */
internal fun eventsSummary(events: List<String>): String? {
    if (events.isEmpty()) return null
    val shown = events.take(3).joinToString(" · ")
    return if (events.size > 3) "$shown +${events.size - 3}" else shown
}

/** Share of successful deliveries, rounded (iOS `successRate`); null with no deliveries. */
internal fun successRate(deliveries: List<WebhookDeliveryRow>): Int? {
    if (deliveries.isEmpty()) return null
    val ok = deliveries.count { it.success == true }
    return (ok.toDouble() / deliveries.size * 100).roundToInt()
}

@OptIn(ExperimentalSerializationApi::class)
private val prettyJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

/** A payload pretty-printed with sorted keys (iOS `prettyJSON`). */
internal fun prettyJson(value: JsonElement): String = prettyJson.encodeToString(JsonElement.serializer(), sortKeys(value))

private fun sortKeys(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.entries.sortedBy { it.key }.associate { it.key to sortKeys(it.value) })
    is JsonArray -> JsonArray(value.map(::sortKeys))
    else -> value
}

/** Outbound webhooks (iOS `WebhooksListModel`), with the list's swipe actions: test and delete. */
class WebhooksViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<List<WebhookRow>>>(LoadState.Idle)
    val state: StateFlow<LoadState<List<WebhookRow>>> = _state.asStateFlow()

    private var loadJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { api.listWebhooks() }
    }

    fun test(webhook: WebhookRow) {
        viewModelScope.launch {
            try {
                val (text, tone) = deliveryNotice(api.testWebhook(webhook.id, event = null))
                notify(text, tone)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun delete(webhook: WebhookRow) {
        viewModelScope.launch {
            try {
                api.deleteWebhook(webhook.id)
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }
}

/** One webhook and its recent deliveries. */
data class WebhookDetail(
    val webhook: WebhookRow,
    val deliveries: List<WebhookDeliveryRow>,
) {
    val successRate: Int?
        get() = successRate(deliveries)
}

/** A webhook's page (iOS `WebhookDetailModel` + actions): test, enable/disable, delete. */
class WebhookDetailViewModel(
    private val api: ApiClient,
    val webhookId: String,
) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<WebhookDetail>>(LoadState.Idle)
    val state: StateFlow<LoadState<WebhookDetail>> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private var loadJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load {
            coroutineScope {
                val deliveries = async {
                    try {
                        api.listWebhookDeliveries(webhookId, limit = 50)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        emptyList()
                    }
                }
                WebhookDetail(api.getWebhook(webhookId), deliveries.await())
            }
        }
    }

    /** Fires a sample delivery of [event] (null = the webhook's first event). */
    fun test(event: String?) = runBusy {
        val (text, tone) = deliveryNotice(api.testWebhook(webhookId, event))
        notify(text, tone)
        load()
    }

    fun toggleActive() = runBusy {
        val webhook = _state.value.value?.webhook ?: return@runBusy
        api.setWebhookActive(webhookId, active = webhook.isPaused)
        load()
    }

    fun delete(onDeleted: () -> Unit) = runBusy {
        api.deleteWebhook(webhookId)
        onDeleted()
    }

    private fun runBusy(block: suspend () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _busy.value = false
            }
        }
    }
}

/** The new-webhook form (iOS `NewWebhookSheet` state). */
data class WebhookDraft(
    val url: String = "",
    val description: String = "",
    val events: Set<String> = setOf("workflow_run.completed"),
) {
    fun canSave(): Boolean = url.isNotBlank() && events.isNotEmpty()

    /** The POST body; events in the catalogue's order, blanks omitted. [secret] is passed separately. */
    fun input(secret: String): WebhookCreateInput = WebhookCreateInput(
        url = url.trim(),
        events = MoreWebhookEvents.all.filter { it in events },
        secret = secret.ifEmpty { null },
        description = description.trim().ifEmpty { null },
    )
}

/** Creates a webhook; the screen pops on success. */
class NewWebhookViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    fun create(
        input: WebhookCreateInput,
        onCreated: (WebhookRow) -> Unit,
    ) {
        if (_saving.value) return
        _saving.value = true
        viewModelScope.launch {
            try {
                onCreated(api.createWebhook(input))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _saving.value = false
            }
        }
    }
}
