import dev.optio.buildlogic.OptioSdk
import dev.optio.buildlogic.addStandardUnitTestDependencies
import dev.optio.buildlogic.configureKotlinCompile
import dev.optio.buildlogic.libs
import dev.optio.buildlogic.pluginId
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.withType

/**
 * `optio.jvm.library`: a pure Kotlin/JVM module (`:core:model`, `:core:network`). No Android
 * framework, so its unit tests run on the plain JVM (`./gradlew :core:model:test`).
 */
class JvmLibraryConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply(libs.pluginId("kotlin-jvm"))
            extensions.configure<JavaPluginExtension> {
                sourceCompatibility = OptioSdk.JAVA_VERSION
                targetCompatibility = OptioSdk.JAVA_VERSION
            }
            tasks.withType<JavaCompile>().configureEach {
                options.release.set(OptioSdk.JAVA_RELEASE)
            }
            tasks.withType<Test>().configureEach {
                useJUnit()
            }
            configureKotlinCompile()
            addStandardUnitTestDependencies()
        }
    }
}
