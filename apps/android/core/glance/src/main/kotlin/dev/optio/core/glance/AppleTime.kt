package dev.optio.core.glance

import java.time.Instant
import kotlin.math.roundToLong

/**
 * Watch wire dates (`WatchState` / `WatchItem` in `SharedTypes.kt`, the FCM `state` frame and
 * `GET /api/glance/watch`) are **Apple reference-date seconds**: seconds since 2001-01-01 UTC,
 * because ActivityKit decodes the iOS Live Activity state with a default `JSONDecoder`. Add
 * [REFERENCE_EPOCH_SECONDS] to get unix seconds.
 */
object AppleTime {
    /** 2001-01-01T00:00:00Z in unix seconds. */
    const val REFERENCE_EPOCH_SECONDS: Long = 978_307_200L

    /** Apple reference-date [seconds] as an [Instant] (millisecond precision). */
    fun toInstant(seconds: Double): Instant = Instant.ofEpochMilli(((seconds + REFERENCE_EPOCH_SECONDS) * 1_000).roundToLong())

    /** [instant] as Apple reference-date seconds. */
    fun seconds(instant: Instant): Double = instant.toEpochMilli() / 1_000.0 - REFERENCE_EPOCH_SECONDS
}

/** This instant as Apple reference-date seconds (the Watch wire format). */
val Instant.appleSeconds: Double
    get() = AppleTime.seconds(this)
