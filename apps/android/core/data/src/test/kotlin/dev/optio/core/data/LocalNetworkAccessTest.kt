package dev.optio.core.data

import java.net.InetAddress
import java.net.UnknownHostException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/** Which hosts need Android 17's local network permission (`LocalNetworkAccess.isLocalHost`). */
class LocalNetworkAccessTest {
    private fun ip(literal: String): InetAddress = InetAddress.getByName(literal)

    @Test
    fun localAddresses() {
        listOf(
            "10.0.2.2", // the emulator host
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.20",
            "169.254.10.20", // link-local
            "100.64.0.1", // CGNAT (Tailscale), conservatively local
            "100.101.102.103",
            "100.127.255.254",
            "224.0.0.251", // mDNS multicast
            "fe80::1", // IPv6 link-local
            "fd7a:115c:a1e0::1", // IPv6 unique-local (Tailscale's ULA)
            "fc00::1",
            "fec0::1", // site-local (deprecated)
            "ff02::fb", // multicast
            "::ffff:192.168.1.20", // IPv4-mapped
        ).forEach { assertTrue(LocalNetworkAccess.isLocalAddress(ip(it)), "$it is local") }
    }

    @Test
    fun notLocalAddresses() {
        listOf(
            "127.0.0.1", // loopback is the device itself
            "::1",
            "0.0.0.0",
            "8.8.8.8",
            "172.15.255.255", // just below 172.16/12
            "172.32.0.1", // just above
            "192.169.0.1",
            "100.63.255.255", // just below 100.64/10
            "100.128.0.1", // just above
            "11.0.0.1",
            "2606:4700:4700::1111",
            "fe00::1", // not fc00::/7 nor fe80::/10
        ).forEach { assertFalse(LocalNetworkAccess.isLocalAddress(ip(it)), "$it is not local") }
    }

    @Test
    fun hostsAreClassifiedByNameOrResolvedAddress() =
        runTest {
            val lookups = mutableListOf<String>()
            val resolver: (String) -> List<InetAddress> = { name ->
                lookups += name
                when (name) {
                    "laptop.lan" -> listOf(ip("192.168.1.20"))
                    "optio.example.com" -> listOf(ip("93.184.216.34"))
                    "mixed.example" -> listOf(ip("93.184.216.34"), ip("10.1.2.3"))
                    "laptop.tailnet.ts.net" -> listOf(ip("100.101.102.103"))
                    else -> throw UnknownHostException(name)
                }
            }
            suspend fun local(host: String) = LocalNetworkAccess.isLocalHost(host, io = Dispatchers.Unconfined, resolve = resolver)

            assertTrue(local("laptop.lan"))
            assertFalse(local("optio.example.com"), "public servers never prompt")
            assertTrue(local("mixed.example"), "any local address counts")
            assertTrue(local("laptop.tailnet.ts.net"), "CGNAT, conservatively")
            assertFalse(local("no-such-host.invalid"), "unresolvable: the permission would not help")

            lookups.clear()
            assertTrue(local("MacBook.local"), "mDNS names need no lookup")
            assertTrue(local("printer.local."))
            assertEquals(emptyList(), lookups)

            // Literals parse without DNS through the default resolver; brackets are IPv6 URL syntax.
            assertTrue(LocalNetworkAccess.isLocalHost("10.0.2.2"))
            assertTrue(LocalNetworkAccess.isLocalHost("[fe80::1]"))
            assertFalse(LocalNetworkAccess.isLocalHost("127.0.0.1"))
            assertFalse(LocalNetworkAccess.isLocalHost(""))
        }

    @Test
    fun carrierGradeNatCanBeLeftOut() {
        assertFalse(LocalNetworkAccess.isLocalAddress(ip("100.101.102.103"), includeCarrierGradeNat = false))
        assertTrue(LocalNetworkAccess.isLocalAddress(ip("192.168.1.20"), includeCarrierGradeNat = false))
        assertTrue(LocalNetworkAccess.isLocalAddress(ip("fd7a:115c:a1e0::1"), includeCarrierGradeNat = false))
    }

    @Test
    fun definitelyLocalHostsLeaveOutTailscale() =
        runTest {
            val resolver: (String) -> List<InetAddress> = { name ->
                if (name == "laptop.tailnet.ts.net") listOf(ip("100.101.102.103")) else listOf(ip("192.168.1.20"))
            }
            assertFalse(LocalNetworkAccess.isLocalHost("laptop.tailnet.ts.net", Dispatchers.Unconfined, resolver, includeCarrierGradeNat = false))
            assertTrue(LocalNetworkAccess.isLocalHost("laptop.lan", Dispatchers.Unconfined, resolver, includeCarrierGradeNat = false))
            assertTrue(LocalNetworkAccess.isLocalHost("MacBook.local", Dispatchers.Unconfined, resolver, includeCarrierGradeNat = false))
        }

    @Test
    fun belowAndroid17NothingIsEnforced() {
        // JVM unit tests see Build.VERSION.SDK_INT = 0.
        assertFalse(LocalNetworkAccess.applies)
    }
}
