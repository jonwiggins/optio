package dev.optio.feature.auth

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lan
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalNetworkAccess
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerColor
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.components.OptioIcons
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.semibold
import kotlinx.coroutines.launch

/** How the sign-in form is used (iOS `SignInView(mode:)`). */
enum class SignInMode {
    /** No server paired yet: the whole app is this screen. */
    FIRST,

    /** Pair another server from the signed-in app ([dev.optio.core.navigation.routes.AddServerRoute]). */
    ADD,
}

/**
 * Pair this phone with an Optio server: its address + a personal access token, verified against
 * `GET /api/auth/me` before anything is stored (port of iOS `SignInView`). It reads as a device
 * pairing, not a SaaS login: identity block, the host in mono, a token, one Connect button, and
 * errors that say precisely what failed.
 *
 * [SignInMode.FIRST] is the root auth gate (the address of the last pairing is prefilled).
 * [SignInMode.ADD] (the `AddServerRoute` screen) also asks for a name and colour so servers are
 * told apart everywhere; on success the new server becomes active and the screen closes.
 */
@Composable
fun SignInScreen(
    mode: SignInMode,
    modifier: Modifier = Modifier,
) {
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val servers by session.servers.collectAsStateWithLifecycle()
    val model = viewModel(key = "sign-in-${mode.name}") { SignInViewModel(mode, session, servers.map { it.color }) }
    val scope = rememberCoroutineScope()

    fun pair(localNetworkBlocked: Boolean) {
        scope.launch {
            if (model.form.submit(session, localNetworkBlocked)) {
                model.form.token = ""
                if (mode == SignInMode.ADD) navigator.pop()
            }
        }
    }

    // Android 17: a server on the local network is unreachable without the local network
    // permission. Ask first when the address is local (never for public servers). After a denial,
    // a definitely-local address fails at once (with Open settings) instead of a connect timeout;
    // a Tailscale address (asked about conservatively) is still tried.
    val localNetworkRequest =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val url = model.form.normalizedUrl
            when {
                granted || url == null -> pair(localNetworkBlocked = false)
                else ->
                    scope.launch {
                        if (LocalNetworkAccess.isBlocked(context, url)) model.form.localNetworkDenied() else pair(localNetworkBlocked = true)
                    }
            }
        }
    SignInContent(
        form = model.form,
        onSubmit = {
            // Keep the progress, and any error with its action, in view.
            focusManager.clearFocus()
            keyboard?.hide()
            val url = model.form.normalizedUrl
            if (model.form.busy || url == null || LocalNetworkAccess.isGranted(context)) {
                pair(localNetworkBlocked = false)
            } else {
                scope.launch {
                    if (LocalNetworkAccess.needsPrompt(context, url)) {
                        localNetworkRequest.launch(LocalNetworkAccess.PERMISSION)
                    } else {
                        pair(localNetworkBlocked = false)
                    }
                }
            }
        },
        onBack = { navigator.pop() },
        onOpenSettings = { context.openAppSettings() },
        modifier = modifier,
    )
}

/** The app's system settings page (where the Nearby devices permission is granted). */
private fun Context.openAppSettings() {
    val intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // No settings app (some test devices): nothing to open.
    }
}

/** Holds the form across configuration changes (never in saved state: the token stays in memory). */
internal class SignInViewModel(
    mode: SignInMode,
    session: SessionStore,
    pairedColors: List<ServerColor>,
) : ViewModel() {
    val form = SignInForm(mode, initialColor = if (mode == SignInMode.ADD) ServerColor.next(pairedColors) else ServerColor.SLATE)

    init {
        if (mode == SignInMode.FIRST) {
            viewModelScope.launch {
                val last = session.registry.lastServerUrl()
                if (last != null && form.serverUrl.isEmpty()) form.serverUrl = last
            }
        }
    }
}

/** The form itself, stateless apart from [form] (screenshot tests drive it directly). */
@Composable
internal fun SignInContent(
    form: SignInForm,
    onSubmit: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenSettings: () -> Unit = {},
) {
    val add = form.mode == SignInMode.ADD
    Scaffold(
        modifier = modifier.testTag(if (add) "add-server-screen" else "sign-in-screen"),
        topBar = {
            if (add) {
                TopAppBar(
                    title = { Text("Add Server") },
                    navigationIcon = {
                        IconButton(onClick = onBack, enabled = !form.busy, modifier = Modifier.testTag("back")) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Cancel")
                        }
                    },
                )
            }
        },
    ) { padding ->
        Box(
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .imePadding()
                    .verticalScroll(rememberScrollState()),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier =
                    Modifier
                        .widthIn(max = 520.dp)
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp)
                        .padding(bottom = 40.dp)
                        .animateContentSize(),
            ) {
                if (add) {
                    AddIntro(Modifier.padding(top = 20.dp, bottom = 28.dp))
                } else {
                    Identity(Modifier.padding(top = 56.dp, bottom = 40.dp))
                }
                SignInFields(form, onSubmit)
                form.error?.let { error ->
                    Text(
                        error.message,
                        style = OptioTheme.type.footnote,
                        color = OptioTheme.colors.red,
                        modifier = Modifier.padding(top = 10.dp).testTag("sign-in-error"),
                    )
                    if (error is SignInError.LocalNetworkBlocked) {
                        TextButton(onClick = onOpenSettings, modifier = Modifier.testTag("open-settings")) {
                            Text("Open settings")
                        }
                    }
                }
                SubmitButton(form, onSubmit, Modifier.padding(top = 24.dp))
                Help(Modifier.padding(top = 28.dp))
            }
        }
    }
}

@Composable
private fun SignInFields(
    form: SignInForm,
    onSubmit: () -> Unit,
) {
    val add = form.mode == SignInMode.ADD
    val nameFocus = remember { FocusRequester() }
    val serverFocus = remember { FocusRequester() }
    val tokenFocus = remember { FocusRequester() }
    var showToken by remember { mutableStateOf(false) }
    val mono = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace)

    LaunchedEffect(Unit) {
        if (form.serverUrl.isEmpty()) runCatching { if (add) nameFocus.requestFocus() else serverFocus.requestFocus() }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (add) {
            OutlinedTextField(
                value = form.name,
                onValueChange = { form.name = it },
                label = { Text("Name") },
                placeholder = { Text(form.namePlaceholder) },
                leadingIcon = { Icon(Icons.Outlined.Laptop, contentDescription = null) },
                singleLine = true,
                enabled = !form.busy,
                keyboardOptions =
                    KeyboardOptions(
                        capitalization = KeyboardCapitalization.Words,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Next,
                    ),
                keyboardActions = KeyboardActions(onNext = { serverFocus.requestFocus() }),
                modifier = Modifier.fillMaxWidth().focusRequester(nameFocus).testTag("server-name"),
            )
            ColorPicker(selection = form.color, onSelect = { form.color = it }, enabled = !form.busy)
        }
        OutlinedTextField(
            value = form.serverUrl,
            onValueChange = { form.serverUrl = it },
            label = { Text("Server") },
            placeholder = { Text("laptop.tailnet.ts.net", style = mono) },
            leadingIcon = { Icon(Icons.Outlined.Lan, contentDescription = null) },
            singleLine = true,
            enabled = !form.busy,
            textStyle = mono,
            keyboardOptions =
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
            keyboardActions = KeyboardActions(onNext = { tokenFocus.requestFocus() }),
            modifier = Modifier.fillMaxWidth().focusRequester(serverFocus).testTag("server-url"),
        )
        OutlinedTextField(
            value = form.token,
            onValueChange = { form.token = it },
            label = { Text("Token") },
            placeholder = { Text("optio_pat_…", style = mono) },
            leadingIcon = { Icon(Icons.Outlined.Key, contentDescription = null) },
            trailingIcon = {
                IconButton(onClick = { showToken = !showToken }) {
                    Icon(
                        if (showToken) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                        contentDescription = if (showToken) "Hide token" else "Show token",
                    )
                }
            },
            singleLine = true,
            enabled = !form.busy,
            textStyle = mono,
            visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions =
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Go,
                ),
            keyboardActions = KeyboardActions(onGo = { onSubmit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(tokenFocus).testTag("server-token"),
        )
    }
}

@Composable
private fun SubmitButton(
    form: SignInForm,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Button(
        onClick = onSubmit,
        enabled = !form.busy && form.canSubmit,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("connect"),
    ) {
        if (form.busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(8.dp))
        }
        Text(
            when {
                form.busy -> "Connecting to ${form.hostLabel}…"
                form.mode == SignInMode.ADD -> "Add server"
                else -> "Connect"
            },
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** First run: the app's identity (iOS `identity`). */
@Composable
private fun Identity(modifier: Modifier = Modifier) {
    val accent = OptioTheme.colors.accent
    Column(modifier, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Box(
            modifier =
                Modifier
                    .size(72.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(accent.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(OptioIcons.Bot, contentDescription = null, tint = accent, modifier = Modifier.padding(17.dp).fillMaxSize())
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Optio", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = (-1).sp, color = OptioTheme.colors.label)
            Text("Remote control for your agents.", style = OptioTheme.type.title3, color = OptioTheme.colors.secondaryLabel)
        }
    }
}

/** Add mode's heading (iOS `addIntro`). */
@Composable
private fun AddIntro(modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Pair another Optio instance", style = OptioTheme.type.title2.semibold(), color = OptioTheme.colors.label)
        Text(
            "A second laptop, a cluster, a teammate's box. The name and colour label its items wherever servers are shown together.",
            style = OptioTheme.type.subheadline,
            color = OptioTheme.colors.secondaryLabel,
        )
    }
}

/** The identity palette (iOS `ServerColorPicker`): one swatch per colour, a check on the chosen one. */
@Composable
private fun ColorPicker(
    selection: ServerColor,
    onSelect: (ServerColor) -> Unit,
    enabled: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FieldLabel("Colour", Icons.Outlined.Palette)
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            ServerColor.entries.forEach { color ->
                val selected = color == selection
                Box(
                    modifier =
                        Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(Color(color.argb))
                            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = { onSelect(color) })
                            .semantics { contentDescription = color.label }
                            .testTag("server-color-${color.raw}"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun FieldLabel(
    text: String,
    icon: ImageVector,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(18.dp))
        Text(text, style = OptioTheme.type.subheadline.medium(), color = OptioTheme.colors.secondaryLabel)
    }
}

/** "Where do I get these?" (iOS `help` disclosure). */
@Composable
private fun Help(modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, label = "help-chevron")
    Column(modifier) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { expanded = !expanded }
                    .padding(vertical = 8.dp)
                    .testTag("sign-in-help"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Where do I get these?",
                style = OptioTheme.type.subheadline,
                color = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.rotate(rotation),
            )
        }
        AnimatedVisibility(visible = expanded) {
            Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                HelpRow("On Tailscale, the address is your Mac's name, like", code = "https://laptop.tailnet.ts.net")
                HelpRow("Tokens come from the web app under Settings › API keys, or from", code = "optio login")
                HelpRow("Local dev with auth disabled accepts any token.", code = null)
            }
        }
    }
}

@Composable
private fun HelpRow(
    text: String,
    code: String?,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(text, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
        if (code != null) {
            SelectionContainer {
                Text(code, style = OptioTheme.type.monoFootnote, color = OptioTheme.colors.label)
            }
        }
    }
}
