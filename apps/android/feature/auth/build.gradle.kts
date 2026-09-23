plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.auth"
}

dependencies {
    // rememberLauncherForActivityResult: the local network permission request (Android 17).
    implementation(libs.androidx.activity.compose)
}
