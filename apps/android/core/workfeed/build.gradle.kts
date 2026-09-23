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
    // WorkView (the feed's saved filters) and the detail routes WorkDestination maps to.
    api(projects.core.navigation)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(projects.core.testing)
}
