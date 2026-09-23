plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.overview"
}

dependencies {
    implementation(projects.core.workfeed)
    // NeedsYouSnapshot: the other paired servers' Local work (Overview › Other servers).
    implementation(projects.core.glance)
}
