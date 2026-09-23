package dev.optio.feature.widgets

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Intents for the app's single activity. Every widget row, tile and shortcut reaches the app as an
 * `optio://` VIEW intent (with `?server=<id>` when it belongs to a particular paired server), which
 * `MainActivity` routes like a notification tap: switch server first, then open the screen.
 */
internal object Links {
    /** `optio://…` for this app only (the VIEW filter on MainActivity), as a new task from outside the app. */
    fun view(
        context: Context,
        url: String,
    ): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    /** The app's launcher intent (the sign-in screen when signed out). */
    fun launch(context: Context): Intent =
        (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
