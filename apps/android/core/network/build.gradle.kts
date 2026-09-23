// Pure Kotlin/JVM: ApiClient (OkHttp 5), WebSocketClient, EventHub, the auth endpoints, and the
// CompositionLocals for them. compose-runtime resolves to its desktop (JVM) variant here and to the
// Android variant in Android consumers; only `staticCompositionLocalOf` is used (no compiler plugin).
plugins {
    alias(libs.plugins.optio.jvm.library)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(projects.core.model)
    api(libs.okhttp)
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.runtime)

    testImplementation(libs.okhttp.mockwebserver)
}
