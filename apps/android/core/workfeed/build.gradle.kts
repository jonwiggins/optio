plugins {
    alias(libs.plugins.optio.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.core.workfeed"
}

dependencies {
    api(projects.core.model)
    api(projects.core.network)
    api(projects.core.data)
    implementation(libs.kotlinx.coroutines.android)
}
