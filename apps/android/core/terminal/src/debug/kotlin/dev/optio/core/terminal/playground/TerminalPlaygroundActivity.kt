package dev.optio.core.terminal.playground

import android.content.Intent
import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.optio.core.terminal.TerminalFonts
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import dev.optio.core.terminal.TerminalInputMode
import dev.optio.core.terminal.TerminalKeyBar
import dev.optio.core.terminal.TerminalSamples
import dev.optio.core.terminal.TerminalState
import dev.optio.core.terminal.TerminalSurface
import dev.optio.core.terminal.TerminalTheme
import kotlinx.coroutines.delay

/**
 * Debug-only playground for `:core:terminal`: canned ANSI screens, a local echo loop for typing and
 * the key bar, and a live Optio Local stream against a test API. Launch it with adb:
 *
 * ```
 * adb shell am start -S -n dev.optio.android/dev.optio.core.terminal.playground.TerminalPlaygroundActivity \
 *   [--es mode samples|echo|live] [--es sample colors|unicode|shell|claude|htop|mouse] \
 *   [--es grid fit|80x24|160x45] [--es theme system|light|dark] [--es input text|raw|prose] \
 *   [--es url http://127.0.0.1:4973 --es token dev --es terminal <uuid>] [--ez focus true]
 * ```
 *
 * For the live stream on an emulator, `adb reverse tcp:4973 tcp:4973` first (Android 17 blocks
 * 10.0.2.2 without the local-network permission; loopback is fine), or install with `-g`.
 */
class TerminalPlaygroundActivity : ComponentActivity() {
    private lateinit var model: PlaygroundModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Only an adb launch with extras configures the playground; a recreation (rotation) or a
        // relaunch without extras (SystemUI after an install) keeps what it was doing.
        val configured = savedInstanceState == null && intent?.extras?.isEmpty == false
        model = PlaygroundModel.obtain(PlaygroundConfig.from(intent), fresh = configured)
        setContent {
            val dark = model.isDark(isSystemInDarkTheme())
            LaunchedEffect(dark) {
                val bars =
                    if (dark) SystemBarStyle.dark(AndroidColor.TRANSPARENT) else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
            PlaygroundScreen(model)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.extras?.isEmpty == false) model.apply(PlaygroundConfig.from(intent))
    }
}

internal enum class PlaygroundMode { Samples, Echo, Live }

internal enum class PlaygroundTheme { System, Light, Dark }

/** Launch extras (see [TerminalPlaygroundActivity]). */
internal data class PlaygroundConfig(
    val mode: PlaygroundMode,
    val sample: String?,
    val grid: TerminalGridMode,
    val theme: PlaygroundTheme,
    val input: TerminalInputMode,
    val url: String,
    val token: String,
    val terminal: String,
    val focus: Boolean,
) {
    companion object {
        fun from(intent: Intent?): PlaygroundConfig {
            fun extra(name: String) = intent?.getStringExtra(name)
            return PlaygroundConfig(
                mode = PlaygroundMode.entries.firstOrNull { it.name.equals(extra("mode"), ignoreCase = true) } ?: PlaygroundMode.Samples,
                sample = extra("sample"),
                grid = parseGrid(extra("grid")),
                theme = PlaygroundTheme.entries.firstOrNull { it.name.equals(extra("theme"), ignoreCase = true) } ?: PlaygroundTheme.System,
                input = TerminalInputMode.entries.firstOrNull { it.name.equals(extra("input"), ignoreCase = true) } ?: TerminalInputMode.Text,
                // Loopback via `adb reverse tcp:4973 tcp:4973`: Android 17 blocks 10.0.2.2 without
                // ACCESS_LOCAL_NETWORK.
                url = extra("url") ?: "http://127.0.0.1:4973",
                token = extra("token") ?: "dev",
                terminal = extra("terminal") ?: "",
                focus = intent?.getBooleanExtra("focus", false) ?: false,
            )
        }

        fun parseGrid(value: String?): TerminalGridMode {
            val m = Regex("""(\d+)x(\d+)""").matchEntire(value.orEmpty()) ?: return TerminalGridMode.Fit
            return TerminalGridMode.Fixed(m.groupValues[1].toInt(), m.groupValues[2].toInt())
        }
    }
}

/** Survives rotation (one per process; the playground is a debug tool). */
internal class PlaygroundModel private constructor(config: PlaygroundConfig) {
    val terminal = TerminalState(config.grid)
    var mode by mutableStateOf(config.mode)
        private set
    var theme by mutableStateOf(config.theme)
    var inputMode by mutableStateOf(config.input)
    var url by mutableStateOf(config.url)
    var token by mutableStateOf(config.token)
    var terminalId by mutableStateOf(config.terminal)
    var sample by mutableStateOf<String?>(null)
        private set
    var animating by mutableStateOf(false)
    var lastInput by mutableStateOf("")
        private set
    var bells by mutableIntStateOf(0)
        private set
    var interactions by mutableIntStateOf(0)
        private set
    var live by mutableStateOf<PlaygroundLocalStream?>(null)
        private set
    private val echo = EchoLoop(terminal)

    init {
        terminal.onInput = { bytes ->
            lastInput = bytes.joinToString(" ") { "%02x".format(it) }.take(60)
            when (mode) {
                PlaygroundMode.Echo -> echo.onInput(bytes)
                PlaygroundMode.Live -> live?.sendInput(bytes)
                PlaygroundMode.Samples -> {}
            }
        }
        terminal.onBell = { bells++ }
        terminal.onInteraction = {
            interactions++
            live?.onInteraction()
        }
        terminal.onGridSizeChanged = { live?.onGridSizeChanged(it) }
        terminal.onNaturalGridChanged = {
            live?.onNaturalGridChanged()
            // Like a TUI on SIGWINCH: redraw the sample for the grid the view now has.
            if (mode == PlaygroundMode.Samples && terminal.gridMode == TerminalGridMode.Fit) sample?.let { play(it) }
        }
        apply(config)
    }

    fun isDark(systemDark: Boolean): Boolean =
        when (theme) {
            PlaygroundTheme.System -> systemDark
            PlaygroundTheme.Light -> false
            PlaygroundTheme.Dark -> true
        }

    fun apply(config: PlaygroundConfig) {
        theme = config.theme
        inputMode = config.input
        url = config.url
        token = config.token
        if (config.terminal.isNotEmpty()) terminalId = config.terminal
        switchTo(config.mode)
        if (config.mode != PlaygroundMode.Live) terminal.gridMode = config.grid
        config.sample?.let { play(it) }
        if (config.mode == PlaygroundMode.Live && terminalId.isNotEmpty()) connect()
        if (config.focus) terminal.focus()
    }

    fun switchTo(next: PlaygroundMode) {
        if (next == mode && (next != PlaygroundMode.Echo || sample == "echo")) return
        disconnect()
        animating = false
        mode = next
        terminal.reset()
        sample = null
        when (next) {
            PlaygroundMode.Echo -> {
                sample = "echo"
                echo.start()
            }
            PlaygroundMode.Live -> terminal.gridMode = TerminalGridMode.Fit
            PlaygroundMode.Samples -> {}
        }
    }

    fun play(id: String) {
        val s = TerminalSamples.byId(id) ?: return
        if (mode != PlaygroundMode.Samples) switchTo(PlaygroundMode.Samples)
        animating = false
        sample = id
        // A TUI draws for the grid it has: in Fit mode wait until the view has laid out
        // (onNaturalGridChanged plays it), or the screen would be drawn for 80×24 and sheared.
        if (terminal.gridMode == TerminalGridMode.Fit && terminal.naturalGrid == null) return
        terminal.reset()
        terminal.feed(s.render(terminal.grid))
    }

    fun setGrid(mode: TerminalGridMode) {
        terminal.gridMode = mode
        sample?.let { if (this.mode == PlaygroundMode.Samples) play(it) }
    }

    fun connect() {
        disconnect()
        terminal.reset()
        terminal.gridMode = TerminalGridMode.Fit
        live = PlaygroundLocalStream(url.trim(), token.trim(), terminalId.trim(), terminal).also { it.connect() }
    }

    fun disconnect() {
        live?.dispose()
        live = null
    }

    companion object {
        private var instance: PlaygroundModel? = null

        fun obtain(config: PlaygroundConfig, fresh: Boolean): PlaygroundModel {
            val existing = instance
            if (existing != null && !fresh) return existing
            if (existing != null) {
                existing.apply(config)
                return existing
            }
            return PlaygroundModel(config).also { instance = it }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun PlaygroundScreen(model: PlaygroundModel) {
    val dark = model.isDark(isSystemInDarkTheme())
    val fg = TerminalTheme.foreground(dark)
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
        Column(
            Modifier
                .fillMaxSize()
                .background(TerminalTheme.background(dark))
                .systemBarsPadding()
                .imePadding()
                .semantics { testTagsAsResourceId = true },
        ) {
            ChipRow {
                PlaygroundMode.entries.forEach { m ->
                    Chip(m.name, model.mode == m, "playground-mode-${m.name.lowercase()}") { model.switchTo(m) }
                }
                Spacer(Modifier.width(8.dp))
                PlaygroundTheme.entries.forEach { t -> Chip(t.name, model.theme == t, "playground-theme-${t.name.lowercase()}") { model.theme = t } }
            }
            ChipRow {
                val grids = listOf(TerminalGridMode.Fit, TerminalGridMode.Fixed(80, 24), TerminalGridMode.Fixed(160, 45), TerminalGridMode.Fixed(45, 30))
                grids.forEach { g ->
                    val label = if (g is TerminalGridMode.Fixed) "${g.cols}×${g.rows}" else "Fit"
                    Chip(label, model.terminal.gridMode == g, "playground-grid-${label.replace("×", "x").lowercase()}") { model.setGrid(g) }
                }
                Spacer(Modifier.width(8.dp))
                TerminalInputMode.entries.forEach { m ->
                    Chip(m.name, model.inputMode == m, "playground-input-${m.name.lowercase()}") { model.inputMode = m }
                }
            }
            when (model.mode) {
                PlaygroundMode.Samples ->
                    ChipRow {
                        TerminalSamples.all.forEach { s -> Chip(s.title, model.sample == s.id, "playground-sample-${s.id}") { model.play(s.id) } }
                        Chip("Animate", model.animating, "playground-animate") {
                            if (model.sample != "htop") model.play("htop")
                            model.animating = !model.animating
                        }
                    }
                PlaygroundMode.Echo -> {}
                PlaygroundMode.Live -> LiveControls(model, dark)
            }
            StatusLine(model, fg)
            model.live?.let { live ->
                live.foreignGrid?.let { grid ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            (if (live.recorded) "Recorded screen" else "Sized for another device") + "  ${grid.cols}×${grid.rows}",
                            color = fg.copy(alpha = 0.7f),
                            fontSize = 12.sp,
                            modifier = Modifier.padding(vertical = 10.dp),
                        )
                        if (!live.recorded) {
                            TextButton(onClick = { live.claim() }, modifier = Modifier.testTag("playground-use-this-screen")) {
                                Text("Use this screen")
                            }
                        }
                    }
                }
            }
            TerminalSurface(
                model.terminal,
                Modifier.weight(1f),
                dark = dark,
                inputMode = model.inputMode,
                readOnly = model.live?.dead == true,
            )
            TerminalKeyBar(model.terminal, dark = dark, enabled = model.mode != PlaygroundMode.Live || model.live?.conn == PlaygroundLocalStream.Conn.Connected)
        }
    }
    LaunchedEffect(model.animating) {
        var frame = 1
        while (model.animating) {
            delay(400)
            val g = model.terminal.grid
            model.terminal.feed(TerminalSamples.altScreen(g.cols, g.rows, frame++))
        }
    }
}

@Composable
private fun LiveControls(model: PlaygroundModel, dark: Boolean) {
    Column(Modifier.padding(horizontal = 12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = model.url,
                onValueChange = { model.url = it },
                label = { Text("API") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.weight(1f).testTag("playground-url"),
            )
            OutlinedTextField(
                value = model.token,
                onValueChange = { model.token = it },
                label = { Text("Token") },
                singleLine = true,
                modifier = Modifier.width(96.dp).testTag("playground-token"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = model.terminalId,
                onValueChange = { model.terminalId = it },
                label = { Text("Terminal id") },
                singleLine = true,
                modifier = Modifier.weight(1f).testTag("playground-terminal-id"),
            )
            val live = model.live
            if (live == null || live.conn == PlaygroundLocalStream.Conn.Disconnected) {
                TextButton(onClick = { model.connect() }, modifier = Modifier.testTag("playground-connect")) { Text("Connect") }
            } else {
                TextButton(onClick = { model.disconnect() }, modifier = Modifier.testTag("playground-disconnect")) { Text("Disconnect") }
            }
        }
        model.live?.let { live ->
            val line = listOfNotNull(live.conn.name.lowercase(), live.status, live.error).joinToString(" · ")
            Text(line, color = TerminalTheme.foreground(dark).copy(alpha = 0.7f), fontSize = 12.sp, modifier = Modifier.testTag("playground-live-status"))
        }
    }
}

@Composable
private fun StatusLine(model: PlaygroundModel, fg: Color) {
    val t = model.terminal
    val mode = when (val m = t.gridMode) {
        TerminalGridMode.Fit -> "fit"
        is TerminalGridMode.Fixed -> "fixed ${m.cols}×${m.rows}"
    }
    val flags =
        listOfNotNull(
            "mouse".takeIf { t.mouseTracking },
            "alt".takeIf { t.altScreen },
            "app-cursor".takeIf { t.applicationCursor },
            "focused".takeIf { t.isFocused },
            "held".takeIf { t.isHolding },
        )
    val natural = t.naturalGrid?.let(TerminalGrid::toString) ?: "?"
    Text(
        text = "${t.grid} ($mode, natural $natural) ${flags.joinToString(" ")}  ⌨ ${model.lastInput}  🔔${model.bells}  ✋${model.interactions}",
        color = fg.copy(alpha = 0.6f),
        fontFamily = TerminalFonts.fontFamily,
        fontSize = 11.sp,
        maxLines = 2,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("playground-status"),
    )
}

@Composable
private fun ChipRow(content: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

@Composable
private fun Chip(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    FilterChip(selected = selected, onClick = onClick, label = { Text(label) }, modifier = Modifier.testTag(tag))
}
