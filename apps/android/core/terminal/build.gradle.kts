import java.util.zip.ZipFile

// Android + Termux libraries only (PLAN §3): no other :core module.
plugins {
    alias(libs.plugins.optio.android.library.compose)
}

android {
    namespace = "dev.optio.core.terminal"
}

// Termux's AARs, resolved only so their classes can be unpacked (see UnpackTermuxClasses).
val termuxAars: Configuration by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = true
    isTransitive = false
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
    }
}

/**
 * Unpacks `classes.jar` from each Termux AAR into `<aar name>.jar` and leaves the rest behind:
 * terminal-emulator's `jni/libtermux.so` (the JNI half of `TerminalSession`, which forks a local
 * process; we never use it, and it is not 16 KB-page aligned, so Android 15+ would show its page-size
 * compatibility dialog) and terminal-view's resources (only `TerminalView`'s selection handles use
 * them). A library module's `packaging { jniLibs.excludes }` never reaches the app's APK, so the
 * AARs themselves stay off every consumer's classpath.
 */
abstract class UnpackTermuxClasses : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val aars: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun unpack() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        aars.files.forEach { aar ->
            ZipFile(aar).use { zip ->
                val entry = zip.getEntry("classes.jar") ?: error("${aar.name} has no classes.jar")
                zip.getInputStream(entry).use { input ->
                    out.resolve("${aar.nameWithoutExtension}.jar").outputStream().use { input.copyTo(it) }
                }
            }
        }
    }
}

val unpackTermuxClasses = tasks.register<UnpackTermuxClasses>("unpackTermuxClasses") {
    aars.from(termuxAars)
    outputDir = layout.buildDirectory.dir("termux-classes")
}

dependencies {
    termuxAars(libs.termux.terminal.emulator)
    termuxAars(libs.termux.terminal.view)
    api(fileTree(unpackTermuxClasses.flatMap { it.outputDir }) { include("*.jar") }.builtBy(unpackTermuxClasses))

    // The debug-only playground (src/debug): a ComponentActivity with Compose, and OkHttp for the
    // live Optio Local stream (PLAN §3 allows it only there; release builds never see either).
    debugImplementation(libs.androidx.activity.compose)
    debugImplementation(libs.okhttp)
}
