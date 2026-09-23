package dev.optio.feature.more.workspace

import androidx.lifecycle.viewModelScope
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.more.api.WorkspaceMemberRow
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.api.addWorkspaceMember
import dev.optio.feature.more.api.deleteWorkspace
import dev.optio.feature.more.api.getWorkspace
import dev.optio.feature.more.api.listWorkspaceMembers
import dev.optio.feature.more.api.listWorkspaces
import dev.optio.feature.more.api.lookupUser
import dev.optio.feature.more.api.removeWorkspaceMember
import dev.optio.feature.more.api.updateWorkspace
import dev.optio.feature.more.api.updateWorkspaceMemberRole
import dev.optio.feature.more.ui.NoticeViewModel
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the workspace screen shows: the workspace, the caller's role in it, and its members. */
data class WorkspaceData(
    val workspace: WorkspaceRow,
    val role: String?,
    val members: List<WorkspaceMemberRow>,
) {
    /** Admins edit settings and manage members (the detail's role, not the session's). */
    val isAdmin: Boolean
        get() = role == "admin"
}

/** The admin-editable fields of the General section. */
data class WorkspaceForm(
    val name: String = "",
    val slug: String = "",
    val description: String = "",
) {
    fun isDirty(workspace: WorkspaceRow): Boolean =
        name != (workspace.name ?: "") || slug != (workspace.slug ?: "") || description != (workspace.description ?: "")

    companion object {
        fun of(workspace: WorkspaceRow) = WorkspaceForm(workspace.name ?: "", workspace.slug ?: "", workspace.description ?: "")
    }
}

/**
 * The workspace settings screen (iOS `WorkspaceSettingsModel` + `WorkspaceSettingsView`): the
 * active workspace (the override, else the user's default, else the first listed), its members,
 * and the admin actions: edit, invite by email, change a role, remove a member, delete.
 */
class WorkspaceSettingsViewModel(
    private val api: ApiClient,
    private val session: SessionStore,
) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<WorkspaceData>>(LoadState.Idle)
    val state: StateFlow<LoadState<WorkspaceData>> = _state.asStateFlow()

    private val _form = MutableStateFlow(WorkspaceForm())
    val form: StateFlow<WorkspaceForm> = _form.asStateFlow()

    private val _busy = MutableStateFlow<Busy?>(null)

    /** The admin action in flight (disables its button and shows a spinner). */
    val busy: StateFlow<Busy?> = _busy.asStateFlow()

    enum class Busy { SAVING, INVITING, DELETING }

    private var loadJob: Job? = null

    fun refresh(workspaceId: String?) {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load(workspaceId) }
    }

    suspend fun load(workspaceId: String?) {
        val data = _state.load {
            val id = workspaceId ?: api.listWorkspaces().firstOrNull()?.id ?: throw ApiError(0, "No workspace selected")
            val detail = api.getWorkspace(id)
            val members = try {
                api.listWorkspaceMembers(id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ApiError) {
                emptyList()
            }
            WorkspaceData(detail.workspace, detail.role, members)
        }
        if (data != null) _form.value = WorkspaceForm.of(data.workspace)
    }

    fun editForm(transform: (WorkspaceForm) -> WorkspaceForm) = _form.update(transform)

    fun save() {
        val data = _state.value.value ?: return
        val form = _form.value
        runBusy(Busy.SAVING) {
            api.updateWorkspace(data.workspace.id, form.name.trim(), form.slug.trim(), form.description.ifBlank { null })
            load(data.workspace.id)
            notify("Workspace updated.")
        }
    }

    /** Looks the user up by email (they must have signed in once) and adds them with [role]. */
    fun invite(
        email: String,
        role: String,
        onDone: () -> Unit = {},
    ) {
        val data = _state.value.value ?: return
        runBusy(Busy.INVITING) {
            val user = api.lookupUser(email.trim())
            api.addWorkspaceMember(data.workspace.id, user.id, role)
            onDone()
            load(data.workspace.id)
            notify("${user.displayName ?: user.email ?: "User"} added to workspace.")
        }
    }

    fun changeRole(
        member: WorkspaceMemberRow,
        role: String,
    ) {
        val data = _state.value.value ?: return
        if (role == member.role) return
        viewModelScope.launch {
            try {
                api.updateWorkspaceMemberRole(data.workspace.id, member.userId, role)
                load(data.workspace.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun remove(member: WorkspaceMemberRow) {
        val data = _state.value.value ?: return
        viewModelScope.launch {
            try {
                api.removeWorkspaceMember(data.workspace.id, member.userId)
                load(data.workspace.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    /** Deletes the workspace; [onDeleted] runs (the screen pops) once the session let go of it. */
    fun delete(onDeleted: () -> Unit) {
        val data = _state.value.value ?: return
        runBusy(Busy.DELETING) {
            api.deleteWorkspace(data.workspace.id)
            if (session.workspaceId.value == data.workspace.id) session.setWorkspaceId(null)
            session.refreshUser()
            onDeleted()
        }
    }

    private fun runBusy(
        kind: Busy,
        block: suspend () -> Unit,
    ) {
        if (_busy.value != null) return
        _busy.value = kind
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _busy.value = null
            }
        }
    }
}
