plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.tasks"
}

dependencies {
    // WatchSources: "Follow in Watch notification" on the task detail (A9's :core:glance).
    implementation(projects.core.glance)
}
