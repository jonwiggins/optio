package dev.optio.feature.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.Samples
import dev.optio.core.ui.hub.LocalHubController
import dev.optio.core.ui.hub.rememberHubController
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces

/** Who is looking: role gating reads `LocalCurrentUser`. */
enum class Viewer(val role: String) {
    ADMIN(CurrentUser.ROLE_ADMIN),
    MEMBER(CurrentUser.ROLE_MEMBER),
    VIEWER(CurrentUser.ROLE_VIEWER),
}

@Composable
fun AsUser(viewer: Viewer, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalCurrentUser provides Samples.currentUser(role = viewer.role), content = content)
}

/**
 * The Library hub's chrome as `:app` draws it (title bar with the section's actions, the
 * Prompts · Repos · Machines · Connections switcher), so section screenshots look like the app.
 */
@Composable
fun LibraryHubFrame(selected: String, content: @Composable (PaddingValues) -> Unit) {
    val controller = rememberHubController()
    val sections = listOf("Prompts", "Repos", "Machines", "Connections")
    Scaffold(
        topBar = {
            Column {
                TopAppBar(title = { Text("Library") }, actions = { controller.actions?.invoke(this) })
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                    sections.forEachIndexed { index, label ->
                        SegmentedButton(
                            selected = label == selected,
                            onClick = {},
                            shape = SegmentedButtonDefaults.itemShape(index = index, count = sections.size),
                            icon = {},
                            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        )
                    }
                }
            }
        },
        floatingActionButton = { controller.fab?.invoke() },
    ) { padding ->
        CompositionLocalProvider(LocalHubController provides controller) { content(padding) }
    }
}

/** A sheet's content drawn full screen on the raised surface (form screenshots without the sheet window). */
@Composable
fun ProvideSheetSurface(content: @Composable () -> Unit) {
    ProvideElevatedSurfaces {
        Box(Modifier.fillMaxSize().background(OptioTheme.colors.page).padding(top = 16.dp)) { content() }
    }
}
