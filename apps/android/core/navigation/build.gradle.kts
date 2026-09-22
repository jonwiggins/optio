plugins {
    alias(libs.plugins.optio.android.library.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.core.navigation"
}

dependencies {
    api(projects.core.data)
    api(libs.androidx.navigation3.runtime)
    api(libs.androidx.compose.runtime)
    api(libs.kotlinx.serialization.json)
}
