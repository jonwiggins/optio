package dev.optio.core.network

import dev.optio.core.model.WorkFormDefaults
import kotlinx.serialization.Serializable

// The New work form's remembered agent settings (`/api/me/work-defaults`): the runtime last used
// and, per runtime, the options last submitted with it.

@Serializable
private data class WorkDefaultsEnvelope(val defaults: WorkFormDefaults = WorkFormDefaults())

/** `GET /api/me/work-defaults`: the caller's remembered settings (empty when none, or auth is off). */
suspend fun ApiClient.getWorkDefaults(): WorkFormDefaults = get<WorkDefaultsEnvelope>("/api/me/work-defaults").defaults

/**
 * `PUT /api/me/work-defaults`: merges [defaults] into the saved ones (`runtime` replaces; each
 * runtime in `agentOptions` replaces that runtime's options; other runtimes are kept). Returns the
 * merged result.
 */
suspend fun ApiClient.putWorkDefaults(defaults: WorkFormDefaults): WorkFormDefaults =
    put<WorkDefaultsEnvelope>("/api/me/work-defaults", defaults).defaults
