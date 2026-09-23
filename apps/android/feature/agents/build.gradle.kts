plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.agents"
}

dependencies {
    // NotificationSubject (alerts about the agent on screen post silently) and WatchSources (a
    // message sent from the phone lets the agent's next turn join the Watch): A9's :core:glance.
    implementation(projects.core.glance)
}
