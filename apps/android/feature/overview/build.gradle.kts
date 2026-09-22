plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.overview"
}

dependencies {
    implementation(projects.core.workfeed)
}
