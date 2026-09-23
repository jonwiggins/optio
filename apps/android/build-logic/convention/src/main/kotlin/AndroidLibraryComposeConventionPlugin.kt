import com.android.build.api.dsl.LibraryExtension
import dev.optio.buildlogic.configureAndroidCompose
import dev.optio.buildlogic.libs
import dev.optio.buildlogic.pluginId
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

/** `optio.android.library.compose`: `optio.android.library` + Compose (+ Roborazzi for tests). */
class AndroidLibraryComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply(libs.pluginId("optio-android-library"))
            extensions.configure<LibraryExtension> {
                configureAndroidCompose(this)
            }
        }
    }
}
