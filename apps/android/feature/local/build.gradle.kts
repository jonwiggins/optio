plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.local"
}

dependencies {
    implementation(projects.core.terminal)
    // NotificationSubject: alerts about the terminal on screen post silently (A9's :core:glance).
    implementation(projects.core.glance)
}
