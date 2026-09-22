plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.local"
}

dependencies {
    implementation(projects.core.terminal)
}
