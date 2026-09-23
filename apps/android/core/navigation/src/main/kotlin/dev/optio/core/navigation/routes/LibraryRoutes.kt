package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:library` (Agent A7). iOS: Features/Library/LibraryHubView.swift,
// Features/More/{Prompts,Repos,Connections}/*.

/** A prompt template; [id] null creates a new one. */
@Serializable
data class PromptDetailRoute(val id: String? = null) : NavKey

/** Edit an existing prompt template (the detail's Edit; iOS `PromptEditorSheet`). */
@Serializable
data class PromptEditRoute(val id: String) : NavKey

@Serializable
data class RepoDetailRoute(val id: String) : NavKey

@Serializable
data class RepoSettingsRoute(val id: String) : NavKey

/** Shared cache directories of a repo. */
@Serializable
data class SharedDirectoriesRoute(val repoId: String) : NavKey

@Serializable
data object NewRepoRoute : NavKey

@Serializable
data class ConnectionDetailRoute(val id: String) : NavKey

/** Configure a new connection for a catalog provider. */
@Serializable
data class NewConnectionRoute(val providerId: String) : NavKey
