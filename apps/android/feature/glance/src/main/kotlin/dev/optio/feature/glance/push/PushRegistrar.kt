package dev.optio.feature.glance.push

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.ServerPushState
import dev.optio.core.model.RegisterAndroidDeviceRequest
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.feature.glance.listNotificationDevices
import dev.optio.feature.glance.registerAndroidDevice
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Registers this device's FCM token with every paired server (port of iOS `PushRegistrar`):
 * `POST /api/notifications/devices` with `platform: "android"`, the app id, the server's profile id
 * as `serverId` (every push then carries it, so taps and actions route without probing), the
 * device name and app version. Re-registers on every launch, when Firebase rotates the token
 * (`onNewToken`) and when notifications are allowed; a server that is forgotten gets a `DELETE`
 * with the address and token it was registered under ([SessionStore.removeServer] deletes the
 * token first, so they are kept from registration time, in memory only, like iOS).
 *
 * Registration waits for the notification permission (a push the phone may not show is a push FCM
 * counts against the app). Everything it learns lands in [PushStatus].
 */
class PushRegistrar(
    private val context: Context,
    private val scope: CoroutineScope,
    private val status: PushStatus,
    private val tokens: FcmTokenSource,
    /** Every paired server with a client, active first. */
    private val clients: suspend () -> List<ServerClient>,
    /** The paired servers (a forgotten one is unregistered). */
    private val servers: StateFlow<List<ServerProfile>>,
    /** Whether notifications can be shown right now. */
    private val permission: () -> NotificationPermissionState = { status.state.value.permission },
) {
    /** Address + credentials each server accepted this device with (for the DELETE after forgetting it). */
    private data class Registered(
        val baseUrl: String,
        val pat: String,
        val workspaceId: String?,
        val token: String,
    )

    private val registeredWith = ConcurrentHashMap<String, Registered>()
    private val mutex = Mutex()

    /** Starts following the servers and the permission, and syncs once. */
    fun start() {
        status.syncHandler = { sync() }
        scope.launch {
            servers.map { list -> list.map { it.id }.toSet() }.distinctUntilChanged().drop(1).collect { sync() }
        }
        scope.launch {
            status.state.map { it.permission }.distinctUntilChanged().drop(1).collect { if (it == NotificationPermissionState.GRANTED) sync() }
        }
        scope.launch { sync() }
    }

    /** Firebase issued a new token: register it everywhere. */
    fun onNewToken(token: String) {
        status.update { it.copy(token = token, fcm = FcmAvailability.Available) }
        scope.launch { sync() }
    }

    /**
     * Registers this device with every paired server and unregisters it from servers forgotten
     * since the last sync. No-op without FCM or without the notification permission.
     */
    suspend fun sync() {
        mutex.withLock {
            val paired = clients()
            forgetRemoved(paired.map { it.server.id }.toSet())
            val availability = tokens.availability()
            if (availability == FcmAvailability.NotConfigured) {
                status.update { it.copy(fcm = FcmAvailability.NotConfigured, servers = idle(paired, it)) }
                return
            }
            val token =
                try {
                    tokens.token()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "no FCM token", e)
                    status.update { it.copy(fcm = FcmAvailability.Unavailable(e.message ?: "Firebase could not issue a token")) }
                    return
                }
            status.update { it.copy(fcm = FcmAvailability.Available, token = token) }
            if (permission() != NotificationPermissionState.GRANTED) {
                status.update { it.copy(servers = idle(paired, it)) }
                return
            }
            coroutineScope { paired.map { c -> async { register(c, token) } }.awaitAll() }
        }
    }

    /** DELETEs this device from every server it registered with (sign-out of the last server). */
    suspend fun unregisterAll() {
        mutex.withLock { forgetRemoved(emptySet()) }
    }

    private suspend fun register(
        client: ServerClient,
        token: String,
    ) {
        val id = client.server.id
        status.update { s -> s.copy(servers = s.servers + (id to (s.servers[id] ?: ServerPushState(id)).copy(registration = PushRegistration.REGISTERING))) }
        val body =
            RegisterAndroidDeviceRequest(
                platform = "android",
                token = token,
                appId = context.packageName,
                appVersion = appVersion(),
                deviceName = deviceName(),
                serverId = id,
            )
        val next =
            try {
                val device = client.api.registerAndroidDevice(body)
                val base = client.api.baseUrl?.toString()
                val pat = client.api.token
                if (base != null && pat != null) registeredWith[id] = Registered(base, pat, client.api.workspaceId, token)
                val canPush = runCatching { client.api.listNotificationDevices().push.fcm }.getOrNull()
                ServerPushState(id, PushRegistration.REGISTERED, serverCanPush = canPush, deviceId = device.id, updatedAt = Instant.now())
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (e.status == ApiError.NOT_FOUND) {
                    ServerPushState(id, PushRegistration.UNSUPPORTED, updatedAt = Instant.now())
                } else {
                    ServerPushState(id, PushRegistration.FAILED, error = e.message, updatedAt = Instant.now())
                }
            } catch (e: Exception) {
                ServerPushState(id, PushRegistration.FAILED, error = e.message, updatedAt = Instant.now())
            }
        status.update { s -> s.copy(servers = s.servers + (id to next)) }
    }

    private suspend fun forgetRemoved(known: Set<String>) {
        for ((id, creds) in registeredWith.toMap()) {
            if (id in known) continue
            registeredWith.remove(id)
            runCatching { ApiClient(creds.baseUrl, creds.pat, creds.workspaceId).delete("/api/notifications/devices/${creds.token}") }
                .onFailure { Log.w(TAG, "unregistering from $id failed", it) }
        }
        status.update { s -> s.copy(servers = s.servers.filterKeys { it in known }) }
    }

    private fun idle(
        paired: List<ServerClient>,
        state: dev.optio.core.glance.PushState,
    ): Map<String, ServerPushState> =
        paired.associate { c ->
            val id = c.server.id
            id to (state.servers[id]?.takeIf { it.registration == PushRegistration.REGISTERED } ?: ServerPushState(id))
        }

    private fun appVersion(): String =
        runCatching {
            val info =
                if (Build.VERSION.SDK_INT >= 33) {
                    context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
                } else {
                    @Suppress("DEPRECATION")
                    context.packageManager.getPackageInfo(context.packageName, 0)
                }
            "${info.versionName} (${info.longVersionCode})"
        }.getOrDefault("0")

    private fun deviceName(): String =
        runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    companion object {
        private const val TAG = "OptioPush"
    }
}
