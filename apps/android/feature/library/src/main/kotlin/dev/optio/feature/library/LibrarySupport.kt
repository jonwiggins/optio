package dev.optio.feature.library

import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.ErrorText
import java.net.URI

// Constants and helpers shared by the Library screens (the Library parts of iOS
// `Features/More/MoreSupport.swift`). Role context (`MoreContext`) has no port: `CurrentUser`
// already decodes `workspaceRole`, so `Roles.canMutate` / `Roles.isAdmin` (core:ui) are iOS's
// `isMember` / `isAdmin`, including "everything is allowed when auth is disabled".

/** A prompt template's kind (the `kind` column), with the web's labels. */
enum class PromptKind(val raw: String, val label: String, val shortLabel: String) {
    PROMPT("prompt", "Coding prompt", "Coding"),
    REVIEW("review", "Code review", "Review"),
    JOB("job", "Standalone task prompt", "Standalone"),
    TASK("task", "Repo task blueprint", "Tasks"),
    ;

    companion object {
        fun fromRaw(raw: String?): PromptKind? = entries.firstOrNull { it.raw == raw }

        /** The long label, or the raw value for a kind this app doesn't know ("prompt" when unset). */
        fun label(raw: String?): String = fromRaw(raw)?.label ?: raw ?: "prompt"

        /** The short label (list rows, filter chips), or the raw value. */
        fun shortLabel(raw: String?): String = fromRaw(raw)?.shortLabel ?: raw ?: "prompt"
    }
}

/** The agent runtimes (web + iOS `MoreAgentTypes`). */
object AgentTypes {
    val all: List<Pair<String, String>> = listOf(
        "claude-code" to "Claude Code",
        "codex" to "OpenAI Codex",
        "copilot" to "GitHub Copilot",
        "gemini" to "Google Gemini",
        "opencode" to "OpenCode",
        "cursor" to "Cursor",
    )

    fun label(value: String): String = all.firstOrNull { it.first == value }?.second ?: value
}

/** Container image presets (web + iOS `MoreImagePresets`). */
object ImagePresets {
    data class Preset(val id: String, val label: String, val description: String)

    val all: List<Preset> = listOf(
        Preset("base", "Base", "Git, Node.js, Python 3, gh CLI, glab CLI, Claude Code. Minimal footprint."),
        Preset("node", "Node.js", "Base + pnpm, yarn, bun, native build tools."),
        Preset("python", "Python", "Base + pip, uv, poetry, venv support."),
        Preset("go", "Go", "Base + Go 1.23, protoc, gopls."),
        Preset("rust", "Rust", "Base + rustup, cargo, cargo-nextest."),
        Preset("ruby", "Ruby", "Base + rbenv, Ruby 3.3, bundler, rake, rubocop, solargraph."),
        Preset("dart", "Dart", "Base + Dart SDK, dart_style."),
        Preset("full", "Full", "Everything above in one image."),
        Preset("dind", "Docker-in-Docker", "Full + a Docker daemon for container builds."),
    )

    fun find(id: String?): Preset? = all.firstOrNull { it.id == id }
}

/** Code-review trigger choices (repo settings, new repo). */
object ReviewTriggers {
    val all: List<Pair<String, String>> = listOf(
        "on_ci_pass" to "After CI passes",
        "on_pr" to "Immediately on PR open",
        "manual" to "Manual only",
    )

    /** iOS `reviewTriggerLabel`: anything unknown reads as the default, "After CI passes". */
    fun label(raw: String?): String = all.firstOrNull { it.first == raw }?.second ?: all.first().second
}

/** Connection permission levels (web + iOS `AccessControlFields`). */
object Permissions {
    val all: List<Pair<String, String>> = listOf(
        "read" to "Read only",
        "readwrite" to "Read & write",
        "full" to "Full access",
    )
}

/**
 * The copy for a failed action (iOS `Error.moreDescription`): a 403 gets a friendlier hint, other
 * API errors show the server's message, and transport failures read as plain words.
 */
fun Throwable.actionMessage(): String {
    val api = this as? ApiError
    if (api != null && api.status == ApiError.FORBIDDEN) {
        return listOf("You don't have permission to do that.", api.message.takeUnless { it.isBlank() || it == "Forbidden" })
            .filterNotNull()
            .joinToString(" ")
    }
    if (api != null && api.status >= 400 && api.message.isNotBlank()) return api.message
    return ErrorText.humanize(this)
}

/** `key=value` lines (preview params, MCP env): blank keys and lines without `=` are skipped. */
fun parseKeyValueLines(text: String): Map<String, String> {
    val result = linkedMapOf<String, String>()
    for (line in text.split('\n')) {
        val index = line.indexOf('=')
        if (index < 0) continue
        val key = line.substring(0, index).trim()
        if (key.isEmpty()) continue
        result[key] = line.substring(index + 1).trim()
    }
    return result
}

/** Non-blank trimmed lines (MCP args, one per line). */
fun parseLines(text: String): List<String> = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }

/**
 * `owner/repo` from a repository URL when validation couldn't tell (iOS `inferFullName`): the first
 * two path segments, `.git` dropped. Null when the URL has fewer.
 */
fun inferFullName(repoUrl: String): String? {
    val path = runCatching { URI(repoUrl.trim()).path }.getOrNull() ?: return null
    val parts = path.split('/').filter { it.isNotEmpty() }
    if (parts.size < 2) return null
    return "${parts[0]}/${parts[1].removeSuffix(".git")}"
}

/** Shared-directory input rules, mirrored from the API's zod schema (its 400 only says "Bad Request"). */
object SharedDirectoryRules {
    private val namePattern = Regex("^[a-z0-9](-?[a-z0-9])*$")
    private val subPathPattern = Regex("^[a-zA-Z0-9._/-]+$")

    /** Why [name] would be rejected, or null when it is fine (empty is "not yet", not an error). */
    fun nameProblem(name: String): String? = when {
        name.isEmpty() -> null
        name.length > 40 -> "At most 40 characters."
        !namePattern.matches(name) -> "Lowercase letters, digits and single hyphens."
        else -> null
    }

    /** Why [path] would be rejected, or null. */
    fun subPathProblem(path: String): String? = when {
        path.isEmpty() -> null
        path.startsWith("/") -> "Relative to the mount location: no leading /."
        path.contains("..") -> "No .. segments."
        path.length > 200 -> "At most 200 characters."
        !subPathPattern.matches(path) -> "Letters, digits and . _ / - only."
        else -> null
    }

    /** Presets (iOS `NewSharedDirectorySheet.presets`): label, name, home-relative sub-path. */
    val presets: List<Triple<String, String, String>> = listOf(
        Triple("npm", "npm-cache", ".npm"),
        Triple("pnpm", "pnpm-store", ".local/share/pnpm/store"),
        Triple("pip", "pip-cache", ".cache/pip"),
        Triple("uv", "uv-cache", ".cache/uv"),
        Triple("cargo", "cargo-registry", ".cargo/registry"),
        Triple("Go modules", "go-mod", "go/pkg/mod"),
        Triple("Gradle", "gradle-cache", ".gradle"),
        Triple("Maven", "m2-repo", ".m2/repository"),
        Triple("HuggingFace", "hf-cache", ".cache/huggingface"),
        Triple("Poetry", "poetry-cache", ".cache/pypoetry"),
    )
}

/** "Recycled 2 pods." / "No idle pods to recycle." */
fun recycleMessage(count: Int): String =
    if (count == 0) "No idle pods to recycle." else "Recycled $count pod${if (count == 1) "" else "s"}."
