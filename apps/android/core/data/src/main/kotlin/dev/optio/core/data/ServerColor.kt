package dev.optio.core.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A server's identity colour on every surface that mixes servers: chips, rows, widget sections
 * (iOS `ServerColor`). Purple stays reserved for "needs you" app-wide, so the first server gets
 * [SLATE] (neutral) and later ones pick the next unused hue ([next]).
 *
 * [argb] holds the exact iOS colour as `0xAARRGGBB`, so UI code builds a Compose colour with
 * `Color(server.color.argb)` without this module depending on Compose UI.
 */
@Serializable
enum class ServerColor(
    /** The stored name (iOS rawValue). */
    val raw: String,
    /** Picker label. */
    val label: String,
    /** The colour as `0xAARRGGBB`. */
    val argb: Long,
) {
    @SerialName("slate")
    SLATE("slate", "Slate", 0xFF64748B),

    @SerialName("blue")
    BLUE("blue", "Blue", 0xFF2F6FED),

    @SerialName("teal")
    TEAL("teal", "Teal", 0xFF0F9F9A),

    @SerialName("green")
    GREEN("green", "Green", 0xFF16A34A),

    @SerialName("amber")
    AMBER("amber", "Amber", 0xFFD97706),

    @SerialName("rose")
    ROSE("rose", "Rose", 0xFFE11D48),

    @SerialName("indigo")
    INDIGO("indigo", "Indigo", 0xFF4F46E5),
    ;

    companion object {
        /** The first colour not used by [existing], cycling when the palette is exhausted. */
        fun next(avoiding: Collection<ServerColor>): ServerColor =
            entries.firstOrNull { it !in avoiding } ?: entries[avoiding.size % entries.size]

        /** The colour stored as [raw], or null. */
        fun fromRaw(raw: String?): ServerColor? = entries.firstOrNull { it.raw == raw }
    }
}
