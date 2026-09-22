package dev.optio.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.LocalNavigator

/**
 * Stand-in for a detail screen that is not built yet: a top app bar with [title] and a back
 * button, then [detail] (the scaffold passes the route key's `toString()`: name and arguments).
 * [onBack] defaults to popping the current tab; pass null to hide the button.
 */
@Composable
fun PlaceholderScreen(
    title: String,
    detail: String? = null,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = LocalNavigator.current.let { navigator -> { navigator.pop() } },
) {
    Scaffold(
        modifier = modifier.testTag("placeholder-screen"),
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Not built yet", style = MaterialTheme.typography.titleMedium)
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

/**
 * Stand-in body for a hub section or single-screen hub that is not built yet. It draws inside
 * the hub's chrome, so it applies [contentPadding] and nothing else. Each of [samples] becomes a
 * button that pushes that route, proving navigation is wired; [extra] adds more controls.
 */
@Composable
fun PlaceholderSection(
    title: String,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    samples: List<NavKey> = emptyList(),
    extra: @Composable () -> Unit = {},
) {
    val navigator = LocalNavigator.current
    LazyColumn(
        modifier = modifier.fillMaxSize().testTag("placeholder-section"),
        contentPadding = contentPadding,
    ) {
        item {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                Text("Not built yet", style = MaterialTheme.typography.bodyMedium)
            }
        }
        items(samples, key = { it.toString() }) { route ->
            OutlinedButton(
                onClick = { navigator.push(route) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp).testTag("push-sample"),
            ) {
                Text("Push $route", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
        item { Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) { extra() } }
    }
}
