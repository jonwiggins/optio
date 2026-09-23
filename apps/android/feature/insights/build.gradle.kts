plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.insights"
}

dependencies {
    implementation(libs.vico.compose.m3)
}
