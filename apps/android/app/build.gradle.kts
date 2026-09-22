plugins {
    alias(libs.plugins.optio.android.application)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.optio.app"

    defaultConfig {
        applicationId = "dev.optio.android"
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

dependencies {
    implementation(projects.core.model)
    implementation(projects.core.network)
    implementation(projects.core.data)
    implementation(projects.core.navigation)
    implementation(projects.core.ui)
    implementation(projects.core.terminal)
    implementation(projects.core.workfeed)
    implementation(projects.core.glance)

    implementation(projects.feature.auth)
    implementation(projects.feature.overview)
    implementation(projects.feature.work)
    implementation(projects.feature.workform)
    implementation(projects.feature.tasks)
    implementation(projects.feature.reviews)
    implementation(projects.feature.insights)
    implementation(projects.feature.local)
    implementation(projects.feature.agents)
    implementation(projects.feature.sessions)
    implementation(projects.feature.library)
    implementation(projects.feature.more)
    implementation(projects.feature.glance)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.compose.material3.adaptive.navigation.suite)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(projects.core.testing)
}
