// :feature:widgets — the home-screen widgets (Work, Run), Quick Settings tiles and app shortcuts
// (iOS OptioWidgets: WorkWidget, RunWidget, the three Controls and their intents). Everything
// reaches the app through `optio://` deep links; the manifest's receivers, services and
// activities merge into the app.
plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.widgets"
}

dependencies {
    implementation(projects.core.glance)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)

    testImplementation(libs.androidx.glance.appwidget.testing)
}
