package dev.optio.buildlogic

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies
import org.gradle.kotlin.dsl.withType
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

/**
 * Compose for an Android module: the Compose compiler plugin, the BOM on every classpath, the
 * core UI artifacts, tooling for previews, and Compose UI tests + Roborazzi for `src/test`.
 */
internal fun Project.configureAndroidCompose(android: CommonExtension) {
    pluginManager.apply(libs.pluginId("kotlin-compose"))
    pluginManager.apply(libs.pluginId("roborazzi"))
    android.buildFeatures.compose = true

    tasks.withType<KotlinJvmCompile>().configureEach {
        compilerOptions {
            // Material 3 still marks everyday components (top app bars, pull-to-refresh, …) experimental.
            optIn.add("androidx.compose.material3.ExperimentalMaterial3Api")
        }
    }

    dependencies {
        val bom = libs.library("androidx-compose-bom")
        add("implementation", platform(bom))
        add("testImplementation", platform(bom))
        add("androidTestImplementation", platform(bom))

        add("implementation", libs.library("androidx-compose-ui"))
        add("implementation", libs.library("androidx-compose-foundation"))
        add("implementation", libs.library("androidx-compose-material3"))
        add("implementation", libs.library("androidx-compose-ui-tooling-preview"))
        add("debugImplementation", libs.library("androidx-compose-ui-tooling"))
        // Supplies the ComponentActivity that createComposeRule() launches under Robolectric.
        add("debugImplementation", libs.library("androidx-compose-ui-test-manifest"))

        add("testImplementation", libs.library("androidx-compose-ui-test-junit4"))
        add("testImplementation", libs.library("roborazzi"))
        add("testImplementation", libs.library("roborazzi-compose"))
        add("testImplementation", libs.library("roborazzi-junit-rule"))
    }
}
