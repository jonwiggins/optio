// Pure Kotlin/JVM: ApiClient (OkHttp 5), WebSocketClient, EventHub.
plugins {
    alias(libs.plugins.optio.jvm.library)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(projects.core.model)
    api(libs.okhttp)
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)

    testImplementation(libs.okhttp.mockwebserver)
}
