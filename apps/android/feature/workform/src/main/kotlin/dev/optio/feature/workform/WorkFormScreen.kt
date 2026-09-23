package dev.optio.feature.workform

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.hairline
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The form's ViewModel: a new form is ready at once; an edit first resolves its id
 * ([loadEditTarget]) and shows the usual loading / error states until then.
 */
class WorkFormViewModel(
    private val api: ApiClient,
    private val preset: String?,
    private val editId: String?,
) : ViewModel() {
    private val _screen = MutableStateFlow<LoadState<WorkFormState>>(LoadState.Idle)
    val screen: StateFlow<LoadState<WorkFormState>> = _screen.asStateFlow()

    init {
        load()
    }

    fun load() {
        if (editId == null) {
            _screen.value = LoadState.Loaded(WorkFormState(api, viewModelScope, presetId = preset).also { it.load() })
            return
        }
        viewModelScope.launch {
            _screen.load { WorkFormState(api, viewModelScope, edit = loadEditTarget(api, editId)).also { it.load() } }
        }
    }
}

/** `NewWorkRoute(preset)`: the New work form, prefilled from [preset] (the first example by default). */
@Composable
fun NewWorkScreen(preset: String? = null) = WorkFormRoute(preset = preset, editId = null)

/** `EditWorkRoute(id)`: saved recurring work reopened in the same form, its kind locked. */
@Composable
fun EditWorkScreen(id: String) = WorkFormRoute(preset = null, editId = id)

@Composable
private fun WorkFormRoute(preset: String?, editId: String?) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val vm = viewModel(key = "work-form:${editId ?: "new"}:${preset.orEmpty()}") { WorkFormViewModel(api, preset, editId) }
    val screen by vm.screen.collectAsStateWithLifecycle()
    val form = screen.value
    if (form != null) {
        WorkFormScreen(
            state = form,
            onClose = navigator::pop,
            onCreated = { navigator.showCreatedWork(it.route, it.toast) },
            onStartNew = { navigator.push(NewWorkRoute()) },
        )
    } else {
        WorkFormFrame(title = if (editId != null) "Edit work" else "New work", onClose = navigator::pop) { padding ->
            Loadable(state = screen, onRetry = vm::load, what = "this work", onRefresh = null, contentPadding = padding) {}
        }
    }
}

/** The bare frame (top app bar with close) the form and its loading state share. */
@Composable
private fun WorkFormFrame(
    title: String,
    onClose: () -> Unit,
    closeEnabled: Boolean = true,
    bottomBar: @Composable (bottomInset: Dp) -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    // The keyboard and the navigation bar are measured from the window's bottom, but inside the
    // shell the form ends above the tab bar (whose own padding already covers the navigation bar,
    // and whose ancestors consume insets unevenly). So the bottom bar's inset is plain geometry:
    // how far the keyboard (or the navigation bar) reaches above the form's bottom edge.
    val density = LocalDensity.current
    var belowPx by remember { mutableIntStateOf(0) }
    val reach = maxOf(WindowInsets.ime.getBottom(density), WindowInsets.navigationBars.getBottom(density))
    val bottomInset = with(density) { (reach - belowPx).coerceAtLeast(0).toDp() }
    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned { coords ->
                val rootHeight = coords.findRootCoordinates().size.height.toFloat()
                belowPx = (rootHeight - coords.boundsInRoot().bottom).coerceAtLeast(0f).toInt()
            },
    ) {
        FormScaffold(title, onClose, closeEnabled, { bottomBar(bottomInset) }, content)
    }
}

@Composable
private fun FormScaffold(
    title: String,
    onClose: () -> Unit,
    closeEnabled: Boolean,
    bottomBar: @Composable () -> Unit,
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onClose, enabled = closeEnabled, modifier = Modifier.testTag("work-form-close")) {
                        Icon(Icons.Filled.Close, contentDescription = "Close")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = OptioTheme.colors.page,
                    scrolledContainerColor = OptioTheme.colors.page,
                ),
            )
        },
        bottomBar = bottomBar,
        containerColor = OptioTheme.colors.page,
        content = content,
    )
}

/**
 * The one creation form, native (iOS `WorkFormView`): example presets up top, six cards in
 * dependency order (When, Where, Who, What, Then, Name), and one bar pinned at the bottom that
 * says in a sentence what you're about to make and holds the button that makes it. There is no
 * "type" to pick: the row it becomes is derived from the answers ([deriveKind]).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WorkFormScreen(
    state: WorkFormState,
    onClose: () -> Unit,
    onCreated: (Created) -> Unit,
    onStartNew: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val toaster = LocalToaster.current
    val scroll = rememberScrollState()
    val offsets = remember { HashMap<FormSection, Int>() }
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current

    fun jump(section: FormSection) {
        val y = offsets[section] ?: return
        scope.launch { scroll.animateScrollTo((y - with(density) { Spacing.s.roundToPx() }).coerceAtLeast(0)) }
    }

    fun submit() {
        if (state.canSubmit) {
            scope.launch { state.submit()?.let(onCreated) }
        } else {
            state.firstGap?.let { gap ->
                haptics.performHapticFeedback(HapticFeedbackType.Reject)
                jump(gap.section)
            }
        }
    }

    // Surface a failed submit as a toast, once.
    LaunchedEffect(state) {
        snapshotFlow { state.error }.filter { it != null }.collect { message ->
            toaster.error(message!!)
            state.error = null
        }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.scrollRequest }.filter { it != null }.collect { section ->
            delay(400)
            jump(section!!)
            state.scrollRequest = null
        }
    }
    DevScript(state, onSubmit = ::submit)
    BackHandler(enabled = state.submitting) {}

    WorkFormFrame(
        title = if (state.isEditing) "Edit work" else "New work",
        onClose = onClose,
        closeEnabled = !state.submitting,
        bottomBar = { inset -> SubmitBar(state, inset, onSubmit = ::submit, onJump = { jump(it.section) }) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                // The viewport sits between the bars (the bottom one rides the keyboard), so a
                // focused field is kept in view above it.
                .padding(padding)
                .verticalScroll(scroll)
                .readableWidth()
                .padding(bottom = Spacing.xl)
                .testTag("work-form"),
        ) {
            if (state.isEditing) {
                EditIntro(state, onStartNew)
            } else {
                PresetsSection(state)
            }
            fun Modifier.anchor(section: FormSection) = onGloballyPositioned { offsets[section] = it.positionInParent().y.toInt() }
            WhenSection(state, Modifier.anchor(FormSection.WHEN))
            WhereSection(state, Modifier.anchor(FormSection.WHERE))
            WhoSection(state, Modifier.anchor(FormSection.WHO))
            if (!state.isTerminal && state.kind != WorkKind.POD_SESSION) WhatSection(state, Modifier.anchor(FormSection.WHAT))
            ThenSection(state, Modifier.anchor(FormSection.THEN))
            NameSection(state, Modifier.anchor(FormSection.NAME))
            MoreOptionsSection(state)
        }
    }
    if (state.showDeps) DependenciesSheet(state, onDismiss = { state.showDeps = false })
}

/** Editing: what this form is for, and the way out to new work. */
@Composable
private fun EditIntro(state: WorkFormState, onStartNew: () -> Unit) {
    val kind = state.locked ?: return
    val colors = OptioTheme.colors
    val text = buildAnnotatedString {
        append("The same five answers you gave when you made it. It stays ${kind.noun}; to turn it into something else, ")
        withLink(
            LinkAnnotation.Clickable(
                tag = "new",
                styles = TextLinkStyles(SpanStyle(color = colors.accent, fontWeight = FontWeight.SemiBold)),
            ) { onStartNew() },
        ) { append("start new work") }
        append(".")
    }
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = colors.secondaryLabel,
        modifier = Modifier.padding(start = Spacing.l + Spacing.l, end = Spacing.l + Spacing.l, top = Spacing.s).testTag("work-form-edit-intro"),
    )
}

/**
 * Pinned under the form (iOS `SubmitBar`): the live description of what the answers make, its
 * missing pieces tappable (they scroll to their section), and the one button that makes it. Never
 * a washed-out disabled button: while something is missing the button goes grey and a tap takes
 * you to the first gap. While the keyboard is up only the button stays, so the field keeps room.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SubmitBar(state: WorkFormState, bottomInset: Dp, onSubmit: () -> Unit, onJump: (SentenceField) -> Unit) {
    val colors = OptioTheme.colors
    val ready = state.ready
    val imeVisible = WindowInsets.isImeVisible
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.page)
            .padding(bottom = bottomInset),
    ) {
        Box(Modifier.fillMaxWidth().height(hairline()).background(colors.separator))
        Column(
            Modifier.readableWidth().padding(start = Spacing.l, end = Spacing.l, top = Spacing.m, bottom = Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            AnimatedVisibility(visible = !imeVisible) {
                val parts = state.sentence
                Text(
                    sentenceString(state, parts, onJump, ready),
                    style = OptioTheme.type.footnote,
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = sentenceText(parts) + needsSuffix(state) }
                        .testTag("work-form-sentence"),
                )
            }
            Button(
                onClick = onSubmit,
                enabled = !state.submitting,
                shape = Radius.capsuleShape,
                colors = ButtonDefaults.buttonColors(
                    // iOS systemGray2 while something is missing: grey, never washed out.
                    containerColor = if (ready) colors.accent else Color(if (colors.isDark) 0xFF636366 else 0xFFAEAEB2),
                    contentColor = if (ready && colors.isDark) colors.page else Color.White,
                    disabledContainerColor = colors.accent.copy(alpha = 0.6f),
                    disabledContentColor = Color.White,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 50.dp)
                    .semantics { if (!ready) contentDescription = "${state.submitLabel}. Something is still missing; tap to go to it." }
                    .testTag("work-form-submit"),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    if (state.submitting) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                    }
                    Text(
                        when {
                            !state.submitting -> state.submitLabel
                            state.isEditing -> "Saving…"
                            else -> "Creating…"
                        },
                        style = OptioTheme.type.body.semibold(),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/** What the sentence can't say, as one more gap: a missing prompt, a directory with no git remote. */
private fun needsSuffix(state: WorkFormState): String = when {
    SentenceField.PROMPT in state.gaps -> " Needs a prompt."
    state.wantsRepoUrl && state.effectiveRepoUrl.isEmpty() && SentenceField.CHECKOUT !in state.gaps ->
        if (state.isLocal) " Needs a git checkout." else " Needs a repo."
    else -> ""
}

@Composable
private fun sentenceString(
    state: WorkFormState,
    parts: List<SentencePart>,
    onJump: (SentenceField) -> Unit,
    ready: Boolean,
): AnnotatedString {
    val colors = OptioTheme.colors
    val textColor = if (ready) colors.label else colors.secondaryLabel
    val gapStyle = TextLinkStyles(SpanStyle(color = colors.yellow, fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline))
    return buildAnnotatedString {
        fun gap(text: String, field: SentenceField) {
            withLink(LinkAnnotation.Clickable(tag = field.raw, styles = gapStyle) { onJump(field) }) { append(text) }
        }
        parts.forEachIndexed { i, part ->
            when (part) {
                is SentencePart.Text -> withStyle(SpanStyle(color = textColor)) {
                    append(inlineCode(if (i > 0 && !part.isPunctuation()) " ${part.text}" else part.text))
                }
                is SentencePart.Missing -> {
                    if (i > 0) append(" ")
                    gap(part.text, part.field)
                }
            }
        }
        val needs = when {
            SentenceField.PROMPT in state.gaps -> "a prompt" to SentenceField.PROMPT
            state.wantsRepoUrl && state.effectiveRepoUrl.isEmpty() && SentenceField.CHECKOUT !in state.gaps ->
                if (state.isLocal) "a git checkout" to SentenceField.CHECKOUT else "a repo" to SentenceField.REPO
            else -> null
        }
        if (needs != null) {
            withStyle(SpanStyle(color = colors.secondaryLabel)) { append(" Needs ") }
            gap(needs.first, needs.second)
            withStyle(SpanStyle(color = colors.secondaryLabel)) { append(".") }
        }
    }
}

// region Dev script (debug builds only)

/** Applied once per process, so reopening the form in a debug session starts clean. */
private var devScriptConsumed = false

/**
 * Debug builds read two launch extras (iOS `OPTIO_DEV_NEW_SESSION` / `_TWEAKS`), so every branch
 * of the form can be screenshotted without tapping:
 * `--es OPTIO_DEV_NEW_WORK schedule --es OPTIO_DEV_NEW_WORK_TWEAKS when=github,where=local,scroll=who`.
 * Open the form with `--es OPTIO_DEV_OPEN_URL optio://work/new`. `submit=1` presses the button
 * once the lists have loaded.
 */
@Composable
private fun DevScript(state: WorkFormState, onSubmit: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(state) {
        if (devScriptConsumed || state.isEditing) return@LaunchedEffect
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return@LaunchedEffect
        val intent = context.findActivity()?.intent ?: return@LaunchedEffect
        val preset = intent.getStringExtra("OPTIO_DEV_NEW_WORK")
        val tweaks = intent.getStringExtra("OPTIO_DEV_NEW_WORK_TWEAKS")
        if (preset == null && tweaks == null) return@LaunchedEffect
        devScriptConsumed = true
        snapshotFlow { !state.reposLoading && !state.hostsLoading }.first { it }
        val submit = state.applyDevScript(preset, tweaks)
        if (submit) {
            delay(1_000)
            onSubmit()
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

// endregion
