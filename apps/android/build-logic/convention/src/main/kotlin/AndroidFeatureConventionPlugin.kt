import dev.optio.buildlogic.libs
import dev.optio.buildlogic.library
import dev.optio.buildlogic.pluginId
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies

/**
 * `optio.android.feature`: a `:feature:*` module. Library + Compose + kotlinx.serialization, the
 * five core modules a feature may use (model, network, data, navigation, ui), Navigation 3,
 * lifecycle/ViewModel for Compose, and `:core:testing` for tests.
 *
 * Features never depend on another feature (PLAN §3); extra core modules (`:core:workfeed`,
 * `:core:terminal`, `:core:glance`) are added in the module's own build file.
 */
class AndroidFeatureConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply(libs.pluginId("optio-android-library-compose"))
            pluginManager.apply(libs.pluginId("kotlin-serialization"))
            dependencies {
                add("implementation", project(":core:model"))
                add("implementation", project(":core:network"))
                add("implementation", project(":core:data"))
                add("implementation", project(":core:navigation"))
                add("implementation", project(":core:ui"))

                add("implementation", libs.library("androidx-navigation3-runtime"))
                add("implementation", libs.library("androidx-navigation3-ui"))
                add("implementation", libs.library("androidx-lifecycle-runtime-compose"))
                add("implementation", libs.library("androidx-lifecycle-viewmodel-compose"))
                add("implementation", libs.library("androidx-lifecycle-viewmodel-navigation3"))
                add("implementation", libs.library("kotlinx-coroutines-android"))
                add("implementation", libs.library("kotlinx-serialization-json"))

                add("testImplementation", project(":core:testing"))
            }
        }
    }
}
