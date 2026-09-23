package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:auth` (Agent C). iOS: Features/Auth/SignInView.swift.

/** Pair another Optio server (iOS `SignInView(mode: .add)`). */
@Serializable
data object AddServerRoute : NavKey
