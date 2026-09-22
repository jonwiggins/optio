package dev.optio.buildlogic

import org.gradle.api.JavaVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

/** SDK levels and bytecode targets shared by every module. Change them here, nowhere else. */
object OptioSdk {
    const val MIN_SDK = 29

    /** Newest API level AGP 9.4.1 supports: 37.2 (its MAX_RECOMMENDED_COMPILE_SDK_VERSION). */
    const val COMPILE_SDK = 37
    const val COMPILE_SDK_MINOR = 2
    const val TARGET_SDK = 37

    val JAVA_VERSION: JavaVersion = JavaVersion.VERSION_17
    val JVM_TARGET: JvmTarget = JvmTarget.JVM_17
    const val JAVA_RELEASE = 17
}
