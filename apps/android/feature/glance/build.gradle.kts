plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.glance"

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(projects.core.glance)
    implementation(projects.core.workfeed)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.work.runtime.ktx)

    // FCM client. Always compiled in; it only runs when the app is built with
    // `app/google-services.json` (the google-services plugin then initialises Firebase). Without
    // it every FCM path is a no-op and PushStatus says so (PLAN §8).
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.androidx.work.testing)
}
