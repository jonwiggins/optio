plugins {
    alias(libs.plugins.optio.android.library.compose)
    alias(libs.plugins.kotlin.serialization)
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

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.markdown.renderer.m3)
    implementation(libs.markdown.renderer.coil3)

    testImplementation(projects.core.testing)
}
