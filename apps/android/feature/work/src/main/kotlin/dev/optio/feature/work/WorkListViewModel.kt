package dev.optio.feature.work

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.WsEvent
import dev.optio.core.navigation.WorkView
import dev.optio.core.network.ApiClient
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedModel
import dev.optio.core.workfeed.workFeedSources
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Work › All (iOS `WorkListView`'s state): the merged feed ([WorkFeedModel], polled while the list
 * is on screen and refreshed by `/ws/events`), the selected view, the search text, and whether a
 * pull-to-refresh is spinning.
 *
 * [load] is the six-endpoint fetch ([workFeedSources]); tests pass a fake.
 */
class WorkListViewModel(
    load: suspend () -> WorkFeed.Sources,
    private val events: Flow<WsEvent>? = null,
    initialView: WorkView = WorkView.ACTIVE,
) : ViewModel() {
    /** The list over [api]'s endpoints, refreshed on [events] (`EventHub.events`). */
    constructor(api: ApiClient, events: Flow<WsEvent>?, initialView: WorkView = WorkView.ACTIVE) :
        this(load = { api.workFeedSources() }, events = events, initialView = initialView)

    private val feed = WorkFeedModel(load = load, scope = viewModelScope)

    /** The merged feed. */
    val state: StateFlow<WorkFeedModel.State> = feed.state

    private val _view = MutableStateFlow(initialView)

    /** The saved filter on screen (Active by default, like iOS and the web). */
    val view: StateFlow<WorkView> = _view.asStateFlow()

    private val _query = MutableStateFlow("")

    /** Free-text search over name, place, agent, status and note. */
    val query: StateFlow<String> = _query.asStateFlow()

    private val _searching = MutableStateFlow(false)

    /** The search field is open (the top bar's search action). */
    val searching: StateFlow<Boolean> = _searching.asStateFlow()

    private val _refreshing = MutableStateFlow(false)

    /** A pull-to-refresh / Retry is running (background polls stay silent). */
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    fun select(view: WorkView) {
        _view.value = view
    }

    fun setQuery(query: String) {
        _query.value = query
    }

    /** Opens the search field, or closes it and clears the search. */
    fun toggleSearch() {
        if (_searching.value || _query.value.isNotEmpty()) {
            _searching.value = false
            _query.value = ""
        } else {
            _searching.value = true
        }
    }

    /** Pull-to-refresh and Retry: refetch now with the spinner showing. */
    fun refresh() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            try {
                feed.refresh()
            } finally {
                _refreshing.value = false
            }
        }
    }

    /** The list appeared: poll (refreshing now) and follow `/ws/events` (iOS `onAppear { model.start() }`). */
    fun start() = feed.start(events = events)

    /** The list went away (another section or tab, a detail on top, the app backgrounded). */
    fun stop() = feed.stop()
}
