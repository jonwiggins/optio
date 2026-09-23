package dev.optio.feature.tasks.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.flow.Flow

/** A one-shot outcome a ViewModel reports to its screen (iOS `toast` / `errorToast` / `dismiss`). */
sealed interface UiMessage {
    /** A success confirmation ("Review agent launched"). */
    data class Success(val text: String) : UiMessage

    /** An action failed. */
    data class Failure(val error: Throwable, val what: String? = null) : UiMessage

    /** The thing on screen is gone (deleted): leave the screen. */
    data object Close : UiMessage
}

/** Forwards [messages] to the app's toaster; [UiMessage.Close] pops the screen. */
@Composable
fun CollectUiMessages(messages: Flow<UiMessage>) {
    val toaster = LocalToaster.current
    val navigator = LocalNavigator.current
    LaunchedEffect(messages, toaster, navigator) {
        messages.collect { message ->
            when (message) {
                is UiMessage.Success -> toaster.success(message.text)
                is UiMessage.Failure -> toaster.error(message.error, message.what)
                UiMessage.Close -> navigator.pop()
            }
        }
    }
}
