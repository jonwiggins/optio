// Test helpers; other modules use it via testImplementation(projects.core.testing) (the feature
// convention plugin adds it). Screenshots (captureScreens), FakeOptioServer, Fixtures, Samples.
plugins {
    alias(libs.plugins.optio.android.library.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.core.testing"
}

dependencies {
    api(projects.core.model)
    api(projects.core.network)
    implementation(projects.core.ui)

    api(libs.junit4)
    api(libs.kotlin.test.junit)
    api(libs.kotlinx.coroutines.test)
    api(libs.turbine)
    api(libs.robolectric)
    api(libs.androidx.test.core.ktx)
    api(libs.androidx.test.ext.junit)
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.ui.test.junit4)
    api(libs.roborazzi)
    api(libs.roborazzi.compose)
    api(libs.roborazzi.junit.rule)
    api(libs.okhttp.mockwebserver)
}
