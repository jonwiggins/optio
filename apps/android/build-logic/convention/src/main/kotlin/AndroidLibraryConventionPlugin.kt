import com.android.build.api.dsl.LibraryExtension
import dev.optio.buildlogic.OptioSdk
import dev.optio.buildlogic.addRobolectricTestDependencies
import dev.optio.buildlogic.configureAndroidCommon
import dev.optio.buildlogic.libs
import dev.optio.buildlogic.pluginId
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

/** `optio.android.library`: an Android library without Compose (core:data, core:workfeed, …). */
class AndroidLibraryConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply(libs.pluginId("android-library"))
            extensions.configure<LibraryExtension> {
                configureAndroidCommon(this)
                // Libraries have no targetSdk of their own; these drive unit tests and lint.
                testOptions.targetSdk = OptioSdk.TARGET_SDK
                lint.targetSdk = OptioSdk.TARGET_SDK
            }
            addRobolectricTestDependencies()
        }
    }
}
