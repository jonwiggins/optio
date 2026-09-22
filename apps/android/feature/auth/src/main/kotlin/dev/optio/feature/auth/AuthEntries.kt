package dev.optio.feature.auth

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.AddServerRoute

/** Registers `:feature:auth`'s routes ([AddServerRoute]). Called once by `MainShell`. */
fun EntryProviderScope<NavKey>.authEntries() {
    entry<AddServerRoute> { SignInScreen(mode = SignInMode.ADD) }
}
