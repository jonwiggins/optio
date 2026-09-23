package dev.optio.core.data

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Android 17's local network protection (the counterpart of iOS's Local Network privacy prompt).
 * An app targeting API 37 may not reach devices on the local network (a laptop at
 * `192.168.1.20:30400`, the emulator host `10.0.2.2`) without the runtime permission [PERMISSION]
 * ("Nearby devices"). Without it, connections are dropped silently and requests time out.
 *
 * Ask only when it matters: [needsPrompt] is true when the permission is enforced, not granted,
 * and the server's host is local ([isLocalHost]). Public servers never trigger the prompt.
 * On older Android versions the permission does not exist and nothing is blocked.
 */
object LocalNetworkAccess {
    /** `Manifest.permission.ACCESS_LOCAL_NETWORK` (API 37). */
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

    /** The first API level that enforces [PERMISSION]. */
    const val MIN_SDK = 37

    /** True on Android versions that enforce [PERMISSION]. */
    val applies: Boolean
        get() = Build.VERSION.SDK_INT >= MIN_SDK

    /** True when this app may reach local network devices (always below [MIN_SDK]). */
    fun isGranted(context: Context): Boolean =
        !applies || context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    /** True when talking to [serverUrl] needs [PERMISSION] and it has not been granted yet. */
    suspend fun needsPrompt(
        context: Context,
        serverUrl: String,
    ): Boolean {
        if (isGranted(context)) return false
        val host = serverUrl.toHttpUrlOrNull()?.host ?: return false
        return isLocalHost(host)
    }

    /**
     * True when [host] points at the local network: a `.local` (mDNS) name, or a name / literal
     * whose addresses include a local one ([isLocalAddress]). Names are resolved with [resolve] on
     * [io]; a name that does not resolve counts as not local (the permission would not help).
     */
    suspend fun isLocalHost(
        host: String,
        io: CoroutineDispatcher = Dispatchers.IO,
        resolve: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() },
    ): Boolean {
        val name = host.trim().removePrefix("[").removeSuffix("]").trimEnd('.').lowercase()
        if (name.isEmpty()) return false
        if (name == "local" || name.endsWith(".local")) return true
        val addresses = withContext(io) { runCatching { resolve(name) }.getOrDefault(emptyList()) }
        return addresses.any(::isLocalAddress)
    }

    /**
     * True for addresses on the local network: private IPv4 (10/8, 172.16/12, 192.168/16),
     * link-local (169.254/16, fe80::/10), IPv6 unique-local (fc00::/7) and site-local (fec0::/10),
     * multicast, and, conservatively, carrier-grade NAT 100.64/10 (Tailscale addresses). Loopback
     * and public addresses are not.
     */
    fun isLocalAddress(address: InetAddress): Boolean {
        if (address.isLoopbackAddress || address.isAnyLocalAddress) return false
        if (address.isSiteLocalAddress || address.isLinkLocalAddress || address.isMulticastAddress) return true
        val bytes = address.address
        return when (address) {
            is Inet4Address -> bytes[0].toInt() and 0xFF == 100 && (bytes[1].toInt() and 0xC0) == 64
            is Inet6Address -> (bytes[0].toInt() and 0xFE) == 0xFC
            else -> false
        }
    }
}
