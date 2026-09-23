plugins {
    alias(libs.plugins.optio.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.core.data"
}

dependencies {
    api(projects.core.model)
    api(projects.core.network)
    api(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.okhttp.mockwebserver)
}
