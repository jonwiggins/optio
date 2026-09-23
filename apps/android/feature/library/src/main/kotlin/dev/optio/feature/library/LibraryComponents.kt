package dev.optio.feature.library

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Power
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material.icons.outlined.Work
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.SectionHeaderDefaults
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.tabularNums
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import androidx.compose.ui.text.style.TextAlign
import dev.optio.core.ui.components.hairline
import kotlinx.coroutines.launch

// Building blocks shared by the Library screens: the inset-grouped look of iOS `.insetGrouped`
// lists and `Form`s (rows on cards, section headers and footers), form rows (text fields,
// switches, pickers, steppers, action rows) and swipe-to-delete.

// region Screen chrome

/** How a pushed screen leaves: Back (details) or Close (forms that discard on leave). */
enum class LeaveIcon { BACK, CLOSE }

/**
 * A pushed Library screen: a top app bar with [title], a Back (or Close) button that pops the
 * current tab, and [actions]; the page background comes from the theme.
 */
@Composable
internal fun LibraryScaffold(
    title: String,
    modifier: Modifier = Modifier,
    leaveIcon: LeaveIcon = LeaveIcon.BACK,
    onLeave: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val navigator = LocalNavigator.current
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onLeave ?: { navigator.pop() }, modifier = Modifier.testTag("back")) {
                        when (leaveIcon) {
                            LeaveIcon.BACK -> Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                            LeaveIcon.CLOSE -> Icon(Icons.Outlined.Close, contentDescription = "Cancel")
                        }
                    }
                },
                actions = actions,
            )
        },
        content = content,
    )
}

// endregion

// region Grouped lazy lists

/** Where a row sits in its card: decides which corners are rounded. */
internal enum class CardPosition { SINGLE, FIRST, MIDDLE, LAST }

internal fun cardPosition(index: Int, count: Int): CardPosition = when {
    count <= 1 -> CardPosition.SINGLE
    index == 0 -> CardPosition.FIRST
    index == count - 1 -> CardPosition.LAST
    else -> CardPosition.MIDDLE
}

private fun CardPosition.shape(): RoundedCornerShape {
    val r = Radius.card
    return when (this) {
        CardPosition.SINGLE -> RoundedCornerShape(r)
        CardPosition.FIRST -> RoundedCornerShape(topStart = r, topEnd = r)
        CardPosition.LAST -> RoundedCornerShape(bottomStart = r, bottomEnd = r)
        CardPosition.MIDDLE -> RoundedCornerShape(0.dp)
    }
}

/**
 * One row of an inset-grouped card inside a lazy list (iOS `.insetGrouped`): the screen gutter,
 * the card colour, rounded corners at the card's ends and a hairline above every row but the first.
 */
@Composable
internal fun GroupedRow(
    position: CardPosition,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.l)
            .clip(position.shape())
            .background(OptioTheme.colors.card),
    ) {
        if (position == CardPosition.MIDDLE || position == CardPosition.LAST) RowSeparator()
        content()
    }
}

/** Air above a list's first card when it has no section header (iOS inset-grouped top margin). */
internal fun LazyListScope.listTopSpace(key: String = "top-space") {
    item(key = key, contentType = "space") { Spacer(Modifier.height(Spacing.m)) }
}

/**
 * The hairline between two rows of a grouped card in a lazy list: a 1px box inside the row (an
 * [InsetDivider] at the row's clipped top edge would lose half its stroke to the clip).
 */
@Composable
private fun RowSeparator() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = Spacing.l)
            .height(hairline())
            .background(OptioTheme.colors.separator),
    )
}

/** A section header above a grouped card in a lazy list. */
internal fun LazyListScope.groupHeader(title: String, key: String = "header-$title", detail: String? = null) {
    item(key = key, contentType = "header") {
        SectionHeader(
            title,
            detail = detail,
            contentPadding = PaddingValues(start = Spacing.l * 2, end = Spacing.l * 2, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
        )
    }
}

/** A footnote under a grouped card in a lazy list. */
internal fun LazyListScope.groupFooter(text: String, key: String) {
    item(key = key, contentType = "footer") {
        GroupFooterText(text)
    }
}

@Composable
internal fun GroupFooterText(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = OptioTheme.colors.secondaryLabel,
        modifier = modifier.fillMaxWidth().padding(start = Spacing.l * 2, end = Spacing.l * 2, top = Spacing.s),
    )
}

/** Rows of one grouped card: [content] gets each item and its [CardPosition]. */
internal fun <T> LazyListScope.groupedItems(
    items: List<T>,
    key: (T) -> Any,
    content: @Composable LazyItemScope.(item: T, position: CardPosition) -> Unit,
) {
    val count = items.size
    items.forEachIndexed { index, item ->
        item(key = key(item), contentType = "row") {
            content(item, cardPosition(index, count))
        }
    }
}

/** A whole card as one lazy item (a handful of static rows: details, settings). */
internal fun LazyListScope.groupedCard(
    key: String,
    header: String? = null,
    footer: String? = null,
    rows: @Composable () -> Unit,
) {
    item(key = key, contentType = "card") {
        GroupedCard(header = header, footer = footer, rows = rows)
    }
}

/**
 * An inset-grouped card outside a lazy list (sheets, forms). Separate rows with [InsetDivider]. A
 * card without a [header] keeps the same air above it as one with.
 */
@Composable
internal fun GroupedCard(
    modifier: Modifier = Modifier,
    header: String? = null,
    footer: String? = null,
    rows: @Composable () -> Unit,
) {
    Column(modifier.fillMaxWidth()) {
        if (header != null) {
            SectionHeader(
                header,
                contentPadding = PaddingValues(start = Spacing.l * 2, end = Spacing.l * 2, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
            )
        } else {
            // The same air above a card as a section header gives (iOS section spacing).
            Spacer(Modifier.height(Spacing.l + Spacing.xs))
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.l)
                .clip(Radius.cardShape)
                .background(OptioTheme.colors.card),
        ) {
            rows()
        }
        if (footer != null) GroupFooterText(footer)
    }
}

// endregion

// region Rows

/** A footnote line inside a card ("No connections yet…"). */
@Composable
internal fun NoteRow(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = OptioTheme.colors.secondaryLabel,
        modifier = modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding),
    )
}

/**
 * A tappable action inside a card (iOS `Button { Label(…) }` in a List): icon + text in the accent
 * colour, red when [destructive]; a spinner replaces the icon while [busy].
 */
@Composable
internal fun ActionRow(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    destructive: Boolean = false,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val colors = OptioTheme.colors
    val tint = when {
        !enabled -> colors.tertiaryLabel
        destructive -> colors.red
        else -> colors.accent
    }
    Row(
        modifier
            .fillMaxWidth()
            .clickable(enabled = enabled && !busy, role = Role.Button, onClick = onClick)
            .padding(OptioRowDefaults.ContentPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        when {
            busy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            icon != null -> Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
        }
        Text(text, style = OptioTheme.type.body, color = tint)
    }
}

/**
 * A row that pushes another screen (iOS `NavigationLink` in a List): leading icon, title, an
 * optional trailing value, and a chevron.
 */
@Composable
internal fun NavigationRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    trailing: String? = null,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(OptioRowDefaults.ContentPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = colors.accent, modifier = Modifier.size(22.dp))
        Text(title, style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = OptioTheme.type.body.tabularNums(), color = colors.secondaryLabel)
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = colors.tertiaryLabel,
            modifier = Modifier.size(20.dp),
        )
    }
}

/** A read-only on/off line (iOS `toggleRow` in the repo detail): label and a check or an empty circle. */
@Composable
internal fun CheckRow(label: String, on: Boolean, modifier: Modifier = Modifier) {
    val colors = OptioTheme.colors
    Row(
        modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
        Icon(
            if (on) Icons.Filled.CheckCircle else Icons.Outlined.RadioButtonUnchecked,
            contentDescription = if (on) "On" else "Off",
            tint = if (on) colors.green else colors.tertiaryLabel,
            modifier = Modifier.size(22.dp),
        )
    }
}

/** A capsule label inside a row (MCP scope, assignment permission). Lowercase like iOS rows. */
@Composable
internal fun Capsule(text: String, color: Color, modifier: Modifier = Modifier, fill: Color = color.copy(alpha = 0.14f)) {
    Text(
        text.uppercase(),
        style = OptioTheme.type.badge,
        color = color,
        maxLines = 1,
        modifier = modifier.background(fill, Radius.capsuleShape).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** Chips for tags such as capabilities or required secrets (iOS `MoreChipCloud`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChipCloud(items: List<String>, modifier: Modifier = Modifier) {
    FlowRow(
        modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items.forEach { item ->
            Text(
                item,
                style = OptioTheme.type.monoCaption,
                color = OptioTheme.colors.label,
                modifier = Modifier
                    .background(OptioTheme.colors.fillTertiary, Radius.capsuleShape)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

// endregion

// region Form rows

/** Keyboard for code-ish values (names, commands, paths): no autocorrect, no capitals. */
internal val CodeKeyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)

/** Keyboard for URLs. */
internal val UrlKeyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri)

/** Keyboard for secrets: no suggestions, password type. */
internal val SecretKeyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password)

/**
 * A text field on a card row (iOS `TextField` in a `Form`): borderless, with a floating [label]
 * so a filled value keeps its name (null under a section header that already names it). [mono] for commands, paths and template bodies;
 * [supportingText] under it (red when [isError]).
 */
@Composable
internal fun FormTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String?,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    mono: Boolean = false,
    labelMono: Boolean = false,
    required: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailingIcon: (@Composable () -> Unit)? = null,
    supportingText: String? = null,
    isError: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = OptioTheme.colors
    val clear = Color.Transparent
    TextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = label?.let {
            {
                Text(
                    buildAnnotatedString {
                        append(it)
                        if (required) withStyle(SpanStyle(color = colors.red)) { append(" *") }
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontFamily = if (labelMono) FontFamily.Monospace else null,
                )
            }
        },
        placeholder = placeholder?.let { { Text(it, style = if (mono) OptioTheme.type.monoSubheadline else OptioTheme.type.body, color = colors.tertiaryLabel) } },
        textStyle = if (mono) OptioTheme.type.monoSubheadline.copy(color = colors.label) else OptioTheme.type.body.copy(color = colors.label),
        singleLine = singleLine,
        minLines = minLines,
        keyboardOptions = keyboardOptions,
        visualTransformation = visualTransformation,
        trailingIcon = trailingIcon,
        supportingText = supportingText?.let { { Text(it) } },
        isError = isError,
        enabled = enabled,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = clear,
            unfocusedContainerColor = clear,
            disabledContainerColor = clear,
            errorContainerColor = clear,
            focusedIndicatorColor = clear,
            unfocusedIndicatorColor = clear,
            disabledIndicatorColor = clear,
            errorIndicatorColor = clear,
        ),
    )
}

/** A switch row (iOS `Toggle` in a `Form`): the whole row toggles; an optional [subtitle] explains it. */
@Composable
internal fun SwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    enabled: Boolean = true,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(horizontal = Spacing.l, vertical = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = OptioTheme.type.body, color = if (enabled) colors.label else colors.tertiaryLabel)
            if (subtitle != null) Text(subtitle, style = OptioTheme.type.footnote, color = colors.secondaryLabel)
        }
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/**
 * A picker row (iOS menu-style `Picker` in a `Form`): the label, the selected option's text and an
 * up/down glyph; a tap opens the options as a dropdown menu with a check on the selected one.
 */
@Composable
internal fun <T> PickerRow(
    label: String,
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = OptioTheme.colors
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selection }?.second ?: selection?.toString().orEmpty()
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled, role = Role.DropdownList, onClickLabel = label) { expanded = true }
                .padding(OptioRowDefaults.ContentPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(label, style = OptioTheme.type.body, color = if (enabled) colors.label else colors.tertiaryLabel, maxLines = 1)
            Text(
                selectedLabel,
                style = OptioTheme.type.body,
                color = colors.secondaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Outlined.UnfoldMore, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.align(Alignment.TopEnd)) {
            options.forEach { (value, text) ->
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = {
                        expanded = false
                        onSelect(value)
                    },
                    trailingIcon = if (value == selection) {
                        { Icon(Icons.Outlined.Check, contentDescription = "Selected") }
                    } else {
                        null
                    },
                )
            }
        }
    }
}

/**
 * A stepper row (iOS `Stepper`): the label, the value, and − / + buttons that move by [step] and
 * stop at [range]'s ends.
 */
@Composable
internal fun StepperRow(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    range: IntRange,
    modifier: Modifier = Modifier,
    step: Int = 1,
    valueText: String = value.toString(),
) {
    val colors = OptioTheme.colors
    Row(
        modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.s, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
        Text(valueText, style = OptioTheme.type.body.tabularNums().medium(), color = colors.label, modifier = Modifier.padding(end = Spacing.xs))
        IconButton(onClick = { onValueChange((value - step).coerceIn(range)) }, enabled = value > range.first) {
            Icon(Icons.Outlined.Remove, contentDescription = "Decrease $label")
        }
        IconButton(onClick = { onValueChange((value + step).coerceIn(range)) }, enabled = value < range.last) {
            Icon(Icons.Outlined.Add, contentDescription = "Increase $label")
        }
    }
}

// endregion

// region Swipe to delete

/**
 * iOS `.swipeActions(edge: .trailing) { Button(role: .destructive) … }`: swiping the row from the
 * end reveals a red Delete and calls [onDelete] (which asks for confirmation); the row always
 * springs back. TalkBack users get the same action as a custom accessibility action. Disabled
 * (a plain row) when [enabled] is false.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SwipeToDelete(
    enabled: Boolean,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Delete",
    content: @Composable () -> Unit,
) {
    if (!enabled) {
        Box(modifier) { content() }
        return
    }
    val state = rememberSwipeToDismissBoxState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    SwipeToDismissBox(
        state = state,
        modifier = modifier.semantics {
            customActions = listOf(CustomAccessibilityAction(label) { onDelete(); true })
        },
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            // Nothing behind the row at rest: a red layer would bleed through the card's
            // anti-aliased corners.
            if (state.dismissDirection != SwipeToDismissBoxValue.EndToStart) return@SwipeToDismissBox
            Row(
                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.error).padding(horizontal = Spacing.l),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.onError)
                Spacer(Modifier.width(Spacing.s))
                Text(label, color = MaterialTheme.colorScheme.onError, style = OptioTheme.type.subheadline.medium())
            }
        },
        onDismiss = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) onDelete()
            scope.launch { state.reset() }
        },
    ) {
        Box(Modifier.background(OptioTheme.colors.card)) { content() }
    }
}

// endregion

// region Icons

/** Material glyph for a connection provider's `icon` (iOS `ConnectionIcons.symbol`). */
internal fun providerIcon(icon: String?): ImageVector = when (icon) {
    "notion" -> Icons.Outlined.Description
    "github" -> Icons.Outlined.Code
    "slack" -> Icons.Outlined.Forum
    "linear" -> Icons.Outlined.BarChart
    "database" -> Icons.Outlined.Storage
    "sentry" -> Icons.Outlined.BugReport
    "folder" -> Icons.Outlined.Folder
    "terminal" -> Icons.Outlined.Terminal
    "globe" -> Icons.Outlined.Public
    else -> Icons.Outlined.Power
}

/** Catalog categories in display order (iOS `ConnectionsModel.categories`). */
internal data class ProviderCategory(val key: String, val label: String, val icon: ImageVector)

internal val ProviderCategories: List<ProviderCategory> = listOf(
    ProviderCategory("productivity", "Productivity", Icons.Outlined.Work),
    ProviderCategory("database", "Databases", Icons.Outlined.Storage),
    ProviderCategory("cloud", "Cloud", Icons.Outlined.Cloud),
    ProviderCategory("knowledge", "Knowledge", Icons.AutoMirrored.Outlined.MenuBook),
    ProviderCategory("custom", "Custom", Icons.Outlined.Build),
)

internal val OtherProviderCategory = ProviderCategory("other", "Other", Icons.Outlined.Power)

// endregion

/** Section-header padding for headers placed directly in a lazy list (outside a grouped card). */
internal val ListHeaderPadding: PaddingValues = SectionHeaderDefaults.ContentPadding

// region Sheets

/**
 * A bottom sheet for a small form (iOS `.sheet` with a `NavigationStack` + `Form`): fully expanded,
 * on the raised grouped surface ([ProvideElevatedSurfaces]).
 */
@Composable
internal fun LibrarySheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ProvideElevatedSurfaces {
        ModalBottomSheet(
            onDismissRequest = onDismissRequest,
            modifier = modifier,
            sheetState = sheetState,
            containerColor = OptioTheme.colors.page,
            content = content,
        )
    }
}

/**
 * A sheet's title bar (iOS: Cancel · title · confirm in the sheet's navigation bar). The confirm
 * button shows a spinner while [busy].
 */
@Composable
internal fun SheetHeader(
    title: String,
    onCancel: () -> Unit,
    confirmLabel: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
) {
    Box(modifier.fillMaxWidth().padding(horizontal = Spacing.xs, vertical = Spacing.xs)) {
        TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.CenterStart).testTag("sheet-cancel")) { Text("Cancel") }
        Text(
            title,
            style = OptioTheme.type.headline,
            color = OptioTheme.colors.label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 96.dp),
        )
        Box(Modifier.align(Alignment.CenterEnd)) {
            if (busy) {
                CircularProgressIndicator(Modifier.padding(horizontal = Spacing.l).size(20.dp), strokeWidth = 2.dp)
            } else {
                TextButton(onClick = onConfirm, enabled = confirmEnabled, modifier = Modifier.testTag("sheet-confirm")) {
                    Text(confirmLabel, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

// endregion
