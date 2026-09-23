import com.android.build.api.dsl.ApplicationExtension
import dev.optio.buildlogic.OptioSdk
import dev.optio.buildlogic.addRobolectricTestDependencies
import dev.optio.buildlogic.configureAndroidCommon
import dev.optio.buildlogic.configureAndroidCompose
import dev.optio.buildlogic.libs
import dev.optio.buildlogic.library
import dev.optio.buildlogic.pluginId
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies

/** `optio.android.application`: the `:app` module (Android application + Compose). */
class AndroidApplicationConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply(libs.pluginId("android-application"))
            extensions.configure<ApplicationExtension> {
                configureAndroidCommon(this)
                configureAndroidCompose(this)
                defaultConfig.targetSdk = OptioSdk.TARGET_SDK
            }
            addRobolectricTestDependencies()
            dependencies {
                add("androidTestImplementation", libs.library("androidx-test-ext-junit"))
                add("androidTestImplementation", libs.library("androidx-test-runner"))
                add("androidTestImplementation", libs.library("androidx-test-rules"))
                add("androidTestImplementation", libs.library("androidx-test-espresso-core"))
                add("androidTestImplementation", libs.library("androidx-test-uiautomator"))
                add("androidTestImplementation", libs.library("androidx-compose-ui-test-junit4"))
            }
        }
    }
}
