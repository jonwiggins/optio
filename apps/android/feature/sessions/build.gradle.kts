plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.sessions"
}

dependencies {
    implementation(projects.core.terminal)
}
