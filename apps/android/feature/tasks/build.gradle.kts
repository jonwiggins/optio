plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.tasks"
}

dependencies {
    // WatchSources: "Follow in Watch notification" on the task detail; NotificationSubject: alerts
    // about the task on screen post silently (A9's :core:glance).
    implementation(projects.core.glance)
}
