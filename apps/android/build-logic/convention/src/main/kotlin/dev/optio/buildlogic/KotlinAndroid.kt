package dev.optio.buildlogic

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Project
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.dependencies
import org.gradle.kotlin.dsl.withType
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

/**
 * Settings every Android module (application or library) shares: SDK levels, Java 17 bytecode,
 * and a Robolectric-friendly unit-test setup. Kotlin compiles through AGP 9's built-in Kotlin
 * support, so no `org.jetbrains.kotlin.android` plugin is applied.
 */
internal fun Project.configureAndroidCommon(android: CommonExtension) {
    android.compileSdk = OptioSdk.COMPILE_SDK
    android.compileSdkMinor = OptioSdk.COMPILE_SDK_MINOR
    android.defaultConfig.minSdk = OptioSdk.MIN_SDK
    android.defaultConfig.testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    android.compileOptions.sourceCompatibility = OptioSdk.JAVA_VERSION
    android.compileOptions.targetCompatibility = OptioSdk.JAVA_VERSION
    android.testOptions.unitTests.isIncludeAndroidResources = true
    android.testOptions.unitTests.isReturnDefaultValues = true
    // Shared robolectric.properties (sdk=36; see the file for why).
    android.sourceSets.getByName("test").resources.directories.add(rootDir.resolve("gradle/robolectric").path)
    tasks.withType<Test>().configureEach {
        maxHeapSize = "2g"
        // Robolectric needs no display; keep AWT (used by Roborazzi) headless.
        systemProperty("java.awt.headless", "true")
        // Robolectric on JDK 21+/25 with SDK 36+: its FileDescriptor interceptor reaches into
        // jdk.internal.access, and its native runtime calls System.load.
        jvmArgs(
            "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
            "--add-opens=java.base/java.io=ALL-UNNAMED",
            "--enable-native-access=ALL-UNNAMED",
        )
    }
    configureKotlinCompile()
    addStandardUnitTestDependencies()
}

/** Kotlin compiler settings shared by Android and JVM modules. */
internal fun Project.configureKotlinCompile() {
    tasks.withType<KotlinJvmCompile>().configureEach {
        compilerOptions {
            jvmTarget.set(OptioSdk.JVM_TARGET)
        }
    }
}

/** JUnit 4 + kotlin.test + coroutines-test + Turbine for `src/test`. */
internal fun Project.addStandardUnitTestDependencies() {
    dependencies {
        add("testImplementation", libs.library("junit4"))
        add("testImplementation", libs.library("kotlin-test-junit"))
        add("testImplementation", libs.library("kotlinx-coroutines-test"))
        add("testImplementation", libs.library("turbine"))
    }
}

/** Robolectric + AndroidX Test core for Android unit tests that need a framework. */
internal fun Project.addRobolectricTestDependencies() {
    dependencies {
        add("testImplementation", libs.library("robolectric"))
        add("testImplementation", libs.library("androidx-test-core-ktx"))
        add("testImplementation", libs.library("androidx-test-ext-junit"))
    }
}
