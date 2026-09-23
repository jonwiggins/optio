plugins {
    alias(libs.plugins.optio.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.core.glance"
}

dependencies {
    api(projects.core.model)
    api(projects.core.network)
    api(projects.core.data)
    api(projects.core.workfeed)
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(projects.core.testing)
}
