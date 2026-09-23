# Optio for Android

Native Android client for Optio (Kotlin, Jetpack Compose, Material 3), at parity with the iOS app in
`apps/ios/`. The iOS source is the spec; this app ports its behaviour, data flow and copy, and
adapts the presentation to Material 3. One Activity, five tabs (Overview · Work · Library ·
Insights · More), one Navigation 3 back stack per tab, manual DI, OkHttp + kotlinx.serialization.

## Prerequisites

- Android Studio. Its bundled JetBrains Runtime (JBR 25) runs Gradle; any JDK 17–25 works.
- Android SDK with platform `android-37.2`, build-tools 36.0.0 and platform-tools. AGP downloads
  missing SDK packages itself once the licences are accepted.
- Network access to Google Maven, Maven Central, JitPack (Termux libraries only) and
  services.gradle.org.

## Environment

Every shell that runs Gradle or adb needs:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JBR 25
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
cd apps/android
```

## Commands

```bash
./gradlew assembleDebug                         # debug APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest :core:model:test :core:network:test   # every unit test
./gradlew :feature:tasks:testDebugUnitTest      # one module's tests
./gradlew :feature:tasks:recordRoborazziDebug   # its tests + screenshots in feature/tasks/build/outputs/roborazzi/
./gradlew installDebug                          # install on the running emulator or device
adb shell am start -n dev.optio.android/dev.optio.app.MainActivity
```

`:core:model` and `:core:network` are plain Kotlin/JVM modules, so their tests run with `test`.
Every other module is an Android module and uses `testDebugUnitTest`.

On a shared machine, build only the modules you are working on until you need the app, and never
run `./gradlew --stop`: it stops every Gradle 9.7.1 daemon on the machine, including other people's
builds. `gradle.properties` caps each daemon at a 3 GB heap and 4 workers.

## Toolchain

| Piece       | Version                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| Gradle      | 9.7.1 wrapper, with the configuration cache and the build cache on           |
| AGP         | 9.4.1, using its built-in Kotlin support (no `org.jetbrains.kotlin.android`) |
| Kotlin      | 2.4.20, plus the Compose compiler and kotlinx.serialization plugins          |
| JDK         | Gradle runs on JBR 25; all bytecode targets Java 17                          |
| Android SDK | compileSdk 37 (minor 2, AGP 9.4.1's newest), targetSdk 37, minSdk 29         |
| Compose     | BOM 2026.09.00 (Material 3 1.4.0), Navigation 3 1.1.7, Lifecycle 2.11.0      |

The versions of everything else are in `gradle/libs.versions.toml`, and the SDK levels are in
`build-logic/convention/src/main/kotlin/dev/optio/buildlogic/OptioSdk.kt`.

## Modules

| Module              | Kind            | What it holds                                                                       |
| ------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `:app`              | application     | `OptioApplication` + `AppGraph`, `MainActivity`, root, `MainShell`, the five hubs   |
| `:core:model`       | Kotlin/JVM      | generated wire types (`SharedTypes.kt`), `OptioJson`, serializers                   |
| `:core:network`     | Kotlin/JVM      | `ApiClient`, `WebSocketClient`, `EventHub`, auth endpoints                          |
| `:core:data`        | Android         | server profiles, `TokenStore`, `SessionStore`, `CurrentUser`, `DeepLink`            |
| `:core:navigation`  | Android+Compose | `Tab`, `Section`, `WorkView`, routes, `AppRouter`, `Navigator`                      |
| `:core:ui`          | Android+Compose | `OptioTheme`, shared components, placeholders, the hub slot API                     |
| `:core:terminal`    | Android+Compose | the terminal view and key bar on the Termux emulator libraries                      |
| `:core:testing`     | Android+Compose | Robolectric/Roborazzi helpers, `FakeOptioServer`, sample models (tests only)        |
| `:core:workfeed`    | Android         | the merged Work feed (web `lib/work-feed.ts`)                                       |
| `:core:glance`      | Android         | needs-you snapshots and Watch state for the widgets, tiles and notifications        |
| `:feature:auth`     | feature         | `SignInScreen`, `AddServerRoute`                                                    |
| `:feature:overview` | feature         | `OverviewScreen`                                                                    |
| `:feature:work`     | feature         | `WorkListSection`                                                                   |
| `:feature:workform` | feature         | the New / Edit work form                                                            |
| `:feature:tasks`    | feature         | task, job, job run and scheduled screens                                            |
| `:feature:reviews`  | feature         | `ReviewsSection`, `InboxSection`, review detail                                     |
| `:feature:insights` | feature         | `AnalyticsSection`, `CostsSection`, `ActivitySection`, `ClusterSection`, pod detail |
| `:feature:local`    | feature         | `MachinesSection`, Local terminal and automation screens                            |
| `:feature:agents`   | feature         | persistent-agent chat and form                                                      |
| `:feature:sessions` | feature         | pod session screen                                                                  |
| `:feature:library`  | feature         | `PromptsSection`, `ReposSection`, `ConnectionsSection` and their screens            |
| `:feature:more`     | feature         | `MoreScreen`, settings, admin, servers                                              |
| `:feature:glance`   | feature         | widgets, Quick Settings tiles, the Watch notification, shortcuts, refresh           |

Packages are `dev.optio.core.<module>`, `dev.optio.feature.<module>` and `dev.optio.app`, and the
same names are used as the Android namespaces. The applicationId is `dev.optio.android`. Two
modules share the name `glance` (`:core:glance`, `:feature:glance`), so always refer to them by
path.

### Dependency rules (binding)

```
:app                 → every :feature:* and :core:*
:feature:*           → :core:* only, NEVER another :feature:*
:core:ui             → :core:data, :core:navigation, :core:model
:core:navigation     → :core:data
:core:data           → :core:network → :core:model
:core:workfeed       → :core:data (+ network, model)
:core:glance         → :core:data, :core:workfeed (+ network, model)
:core:terminal       → Android + Termux libraries only
:core:testing        → test helpers, used via testImplementation
```

A feature that needs another feature's screen pushes that feature's route key (every key lives in
`:core:navigation`) and never imports the other feature's code.

## Convention plugins (`build-logic/`)

Module build files apply one of these and add only what is specific to them:

| Plugin id                       | For                            | Adds                                                                                                                                                |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optio.android.application`     | `:app`                         | Android app + Compose, targetSdk, androidTest deps                                                                                                  |
| `optio.android.library`         | non-UI Android modules         | Android library settings + unit-test setup                                                                                                          |
| `optio.android.library.compose` | UI modules                     | the library settings + Compose (BOM, ui, foundation, material3, tooling), Compose UI tests, Roborazzi                                               |
| `optio.android.feature`         | every `:feature:*`             | library.compose + serialization + `:core:model/network/data/navigation/ui` + Navigation 3 + lifecycle/ViewModel Compose + `:core:testing` for tests |
| `optio.jvm.library`             | `:core:model`, `:core:network` | Kotlin/JVM, Java 17, JUnit 4                                                                                                                        |

In module build files use the catalog aliases, e.g. `alias(libs.plugins.optio.android.feature)`.
Add `alias(libs.plugins.kotlin.serialization)` when a non-feature module declares `@Serializable`
types. Every Android module gets minSdk/compileSdk, Java 17, unit tests with Android resources and
default return values, and JUnit 4, `kotlin-test-junit`, coroutines-test, Turbine, Robolectric and
AndroidX Test on the unit-test classpath. Compose modules also opt in to
`ExperimentalMaterial3Api` module-wide.

## Conventions

### Routes

Routes are `@Serializable` Navigation 3 `NavKey`s: a `data class` when they take arguments and a
`data object` when they take none. Each area has one file in
`core/navigation/src/main/kotlin/dev/optio/core/navigation/routes/<Area>Routes.kt` (`TaskRoutes.kt`,
`LibraryRoutes.kt`, …), and owners add routes to their own area file only. Keep arguments to
strings, numbers, booleans and enums. Back stacks are saved across process death by serializing
their keys, so a key must never hold a model object.

```kotlin
@Serializable
data class TaskDetailRoute(val id: String) : NavKey

@Serializable
data object SettingsRoute : NavKey
```

`HubRoute(tab)` is the root of every tab's back stack and is owned by `:app`.

### Entry registration

Each feature module exports exactly one entry function, named after the module, which registers a
screen for each of its routes:

```kotlin
fun EntryProviderScope<NavKey>.tasksEntries() {
    entry<TaskDetailRoute> { key -> TaskDetailScreen(taskId = key.id) }
    entry<JobRunRoute> { key -> JobRunScreen(jobId = key.jobId, runId = key.runId) }
}
```

The functions are `authEntries`, `overviewEntries`, `workEntries`, `workFormEntries`,
`tasksEntries`, `reviewsEntries`, `insightsEntries`, `localEntries`, `agentsEntries`,
`sessionsEntries`, `libraryEntries`, `moreEntries` and `glanceEntries`. `MainShell` calls all of
them once, in `app/src/main/kotlin/dev/optio/app/shell/AppEntries.kt`. An entry's screen draws its
own `Scaffold` and top app bar with a back button that calls `LocalNavigator.current.pop()`.
`viewModel()` inside an entry is scoped to that entry: it lives while the entry is on its back
stack, including while another tab is on screen.

### Sections

Hub sections, and the single-screen hubs `OverviewScreen` and `MoreScreen`, all share one
signature:

```kotlin
@Composable
fun ReposSection(contentPadding: PaddingValues, modifier: Modifier = Modifier)
```

The hub in `:app` draws the chrome: the top app bar with the tab title, the segmented switcher and
the FAB slot. The section draws only its body. It fills the available space and applies
`contentPadding` to its scrolling container (`LazyColumn(contentPadding = contentPadding)`), so the
content scrolls under the bars. It never adds a top bar of its own.

| Hub      | Sections (switcher order)                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | `OverviewScreen` (`:feature:overview`)                                                                                                      |
| Work     | All `WorkListSection` (work) · Reviews `ReviewsSection` · Inbox `InboxSection` (reviews)                                                    |
| Library  | Prompts `PromptsSection` · Repos `ReposSection` (library) · Machines `MachinesSection` (local) · Connections `ConnectionsSection` (library) |
| Insights | `AnalyticsSection` · `CostsSection` · `ActivitySection` · `ClusterSection` (insights)                                                       |
| More     | `MoreScreen` (`:feature:more`)                                                                                                              |

### Hub slot API (`dev.optio.core.ui.hub`)

A section contributes top-bar actions and a FAB to the hub that hosts it:

```kotlin
@Composable
fun ReposSection(contentPadding: PaddingValues, modifier: Modifier = Modifier) {
    val navigator = LocalNavigator.current
    HubActions {
        IconButton(onClick = { navigator.push(NewRepoRoute) }) {
            Icon(Icons.Filled.Add, contentDescription = "Add repo")
        }
    }
    HubFab {
        ExtendedFloatingActionButton(onClick = { … }, icon = { … }, text = { Text("New") })
    }
    LazyColumn(modifier.fillMaxSize(), contentPadding = contentPadding) { … }
}
```

`HubActions { }` takes a `RowScope` lambda for `TopAppBar(actions = …)`, and `HubFab { }` takes the
FAB. A registration lives as long as the section is composed, and the newest one wins. Call each at
most once per section. Outside a hub (details, previews, screenshot tests) both calls do nothing.
The hub side uses `rememberHubController()`, provides it through `LocalHubController`, and renders
`controller.actions` and `controller.fab`.

### Moving around

- `LocalNavigator.current` is what features use. `push(route)` and `pop()` act on the current tab.
  `open(section, view)` switches to the tab that owns the section, pops it to its hub and selects
  the section. `openExternal(url)` opens a Custom Tab. `openDeepLink(url)` routes an `optio://`
  link like a notification tap (a `?server=<id>` for another paired server switches first).
  `showCreatedWork(route, toast)` is the New/Edit work form's "done": it closes the form, lands on
  Work › All with `route` pushed and shows `toast`. The default is `Navigator.None`, so previews and
  screenshots need no setup.
- `LocalAppRouter.current` (the shell and the hubs) holds the selected tab, one
  `SnapshotStateList<NavKey>` back stack per tab, the section selected in each hub, and
  `pendingWorkView`. Tapping the selected tab pops it to its hub, and Back at the hub of any tab
  other than Overview returns to Overview. The router's state survives rotation and process death.
  `handle(url)` / `handle(DeepLink)` route `optio://` links (details push onto the Work tab).

### Tests

- Use JUnit 4 with `kotlin.test` assertions, `kotlinx-coroutines-test` and Turbine.
- For Robolectric, annotate the class with `@RunWith(AndroidJUnit4::class)`. Tests run on **SDK 36**
  by default (`gradle/robolectric/robolectric.properties`, added to every module's test resources):
  on API 37, Espresso 3.7.0's idling hook calls `InputManager.getInstance()`, which no longer exists,
  so every Compose UI test would fail. The test JVM also gets
  `--add-exports java.base/jdk.internal.access=ALL-UNNAMED` (Robolectric on JDK 25).
- For Compose UI tests, use `androidx.compose.ui.test.junit4.v2.createComposeRule`, because the
  un-versioned one is deprecated.
- For screenshots, add `@GraphicsMode(GraphicsMode.Mode.NATIVE)` and call
  `compose.onRoot().captureRoboImage("build/outputs/roborazzi/<Name>.png")`. Files are written only
  by `./gradlew :<module>:recordRoborazziDebug`; `testDebugUnitTest` runs the same test without
  writing. Use `@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)` for phone size and append
  `+night` for dark mode. `app/src/test/.../MainShellTest.kt` is a working example.

### Version catalog

Add entries to `gradle/libs.versions.toml` as needed, but never change an existing version
without the orchestrator. Compose libraries take their version from the BOM. Firebase (BOM +
messaging) and the google-services plugin are declared but not applied until push notifications are
approved.

## Gotchas

- AGP 9 compiles Kotlin itself. Never apply `org.jetbrains.kotlin.android`, and use
  `kotlin { compilerOptions { … } }` or the convention plugins, not `kotlinOptions`.
- Kotlin block comments nest, so a `/*` inside KDoc, such as `Features/Overview/*`, opens a
  comment that never closes ("Unclosed comment").
- `libs.plugins.optio.android.library` is both an alias and the prefix of
  `optio.android.library.compose`. `alias(...)` handles that; code that calls `.get()` needs
  `.asProvider()`.
- Termux artifacts resolve only from JitPack (an exclusive content filter on
  `com.github.termux.*`); nothing else is fetched from JitPack.
- `MainShell` keeps every tab's entries decorated (`rememberDecoratedNavEntries`), so switching tabs
  preserves scroll positions and ViewModels. The root keys it on `session.generation`, so a server
  switch drops all of it (every screen restarts for the new server, like iOS).
- Android 17 (API 37) blocks local-network addresses (a LAN laptop, the emulator's `10.0.2.2`)
  without the runtime permission `ACCESS_LOCAL_NETWORK` ("Nearby devices"): requests just time
  out. The app asks when you connect to a local address (`LocalNetworkAccess` in `:core:data`). For
  scripted runs, install with `adb install -r -g` (grants it) or
  `adb shell pm grant dev.optio.android android.permission.ACCESS_LOCAL_NETWORK`.
- Debug builds read `OPTIO_DEV_*` launch extras (servers, `OPTIO_DEV_SECTION`,
  `OPTIO_DEV_OPEN_URL`, `OPTIO_DEV_TOAST`); see `apps/android/e2e/README.md`. `adb shell` splits
  arguments on spaces, so quote values that contain them twice: `--es OPTIO_DEV_TOAST "'Hello there'"`.

## App icon

The adaptive launcher icon is `app/src/main/res/drawable/ic_launcher_foreground.xml`: the lucide
`bot` glyph from `apps/ios/Design/app-icon.svg`, converted by hand to stroked paths inside the 66dp
safe zone. It sits on `#6d28d9` and doubles as the monochrome (themed-icon) layer.
`./gradlew :app:recordRoborazziDebug` renders it to `app/build/outputs/roborazzi/LauncherIcon.png`,
with the safe zone outlined.
