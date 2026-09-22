// Android + Termux libraries only (PLAN §3): no other :core module.
plugins {
    alias(libs.plugins.optio.android.library.compose)
}

android {
    namespace = "dev.optio.core.terminal"
}

dependencies {
    api(libs.termux.terminal.emulator)
    implementation(libs.termux.terminal.view)
}
