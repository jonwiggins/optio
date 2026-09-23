plugins {
    alias(libs.plugins.optio.android.feature)
}

android {
    namespace = "dev.optio.feature.more"
}

dependencies {
    // Notification devices: this phone's permission and push registration (PushStatus).
    implementation(projects.core.glance)
    // The notification permission prompt (rememberLauncherForActivityResult).
    implementation(libs.androidx.activity.compose)
    // The account card's avatar (iOS AsyncImage).
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.androidx.compose.material.icons.extended)
}
