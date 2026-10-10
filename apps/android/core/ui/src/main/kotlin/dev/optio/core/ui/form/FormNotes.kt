package dev.optio.core.ui.form

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing

/** A multi-select row: a checkbox and its label (event kinds). */
@Composable
fun CheckRow(
    title: String,
    checked: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Checkbox, onValueChange = { onToggle() })
            .padding(start = Spacing.xs, end = Spacing.l),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(Spacing.m))
        Text(title, style = OptioTheme.type.body, color = OptioTheme.colors.label)
    }
}

/** A footnote inside a card (a hint under a control), set like a row's secondary line. */
@Composable
fun CardNote(text: String, modifier: Modifier = Modifier, style: TextStyle = OptioTheme.type.footnote) {
    Text(
        inlineCode(text),
        style = style,
        color = OptioTheme.colors.secondaryLabel,
        modifier = modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
    )
}
