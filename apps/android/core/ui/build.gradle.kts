plugins {
    alias(libs.plugins.optio.android.library.compose)
}

android {
    namespace = "dev.optio.core.ui"
}

dependencies {
    api(projects.core.model)
    api(projects.core.data)
    api(projects.core.navigation)
    api(libs.androidx.compose.material3)
    api(libs.androidx.compose.material.icons.extended)

    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.markdown.renderer.m3)
    implementation(libs.markdown.renderer.coil3)
}
