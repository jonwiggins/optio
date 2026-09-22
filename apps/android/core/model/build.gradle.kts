// Pure Kotlin/JVM: generated wire types (Agent T) + the one OptioJson instance.
plugins {
    alias(libs.plugins.optio.jvm.library)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(libs.kotlinx.serialization.json)
}
