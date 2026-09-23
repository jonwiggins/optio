package dev.optio.feature.local.ui

import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.ErrorText

/**
 * Toast copy for a failed action ([verb]: "kill the terminal"). The server's own reason when it
 * gave one (a 409 "Terminal is exited", a 400 "Webhook path … is already in use"), else core:ui's
 * plain-language copy phrased for an action rather than a load (iOS shows `localizedDescription`).
 */
internal fun actionFailure(
    error: Throwable,
    verb: String,
): String {
    val api = error as? ApiError
    if (api != null) {
        when (api.status) {
            ApiError.NOT_FOUND -> return "Couldn't $verb — it no longer exists."
            in 400..499 ->
                if (api.status != ApiError.UNAUTHORIZED && api.status != ApiError.FORBIDDEN && api.status != ApiError.TOO_MANY_REQUESTS && api.message.isNotBlank()) {
                    return api.message
                }
        }
    }
    val text = ErrorText.humanize(error)
    val generic = "Something went wrong"
    return if (text.startsWith(generic)) "Couldn't $verb" + text.removePrefix(generic) else text
}
