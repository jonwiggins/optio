// Root build: puts every Gradle plugin the modules use on the build classpath (without applying
// it) so the convention plugins in build-logic can apply them by id. Modules never declare plugin
// versions themselves.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.roborazzi) apply false
    // Declared so it resolves; applied to :app only once push notifications are approved (PLAN §8).
    alias(libs.plugins.google.services) apply false
}
