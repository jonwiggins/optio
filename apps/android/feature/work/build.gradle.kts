plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.work"
}

dependencies {
    implementation(projects.core.workfeed)
}
