package dev.optio.feature.widgets.shortcuts

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.config.setThemedContent
import dev.optio.feature.widgets.run.RunFiring
import dev.optio.feature.widgets.run.RunTarget
import kotlinx.coroutines.launch

/**
 * Where a run shortcut lands (iOS `RunJobIntent` / `RunBlueprintIntent` from Shortcuts): a small
 * confirmation over whatever is on screen, then the target fires in the background and a toast
 * says how it went. Nothing else of the app opens.
 */
class RunShortcutActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val target = AppShortcuts.target(intent)
        if (target == null) {
            finish()
            return
        }
        setThemedContent {
            AlertDialog(
                onDismissRequest = ::finish,
                title = { Text("Run ${target.name}?") },
                text = { Text(detail(target)) },
                confirmButton = {
                    TextButton(onClick = { run(target) }, modifier = Modifier.testTag("confirm")) { Text("Run") }
                },
                dismissButton = {
                    TextButton(onClick = ::finish, modifier = Modifier.testTag("dismiss")) { Text("Cancel") }
                },
            )
        }
    }

    private fun run(target: RunTarget) {
        val app = applicationContext
        OptioWidgets.scope.launch { RunFiring.toast(app, RunFiring.fire(app, target)) }
        finish()
    }

    private fun detail(target: RunTarget): String {
        val server = target.serverName?.let { " on $it" }.orEmpty()
        return when {
            target.kind == RunTarget.Kind.JOB -> "Starts a run of this Job$server now."
            target.spawnMode == "auto" -> "It starts immediately on your machine$server."
            else -> "It waits in Optio until you start it$server."
        }
    }
}
