pluginManagement {
    includeBuild("build-logic")
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        // JitPack serves only the Termux terminal libraries (and nothing else resolves there).
        exclusiveContent {
            forRepository { maven("https://jitpack.io") { name = "JitPack" } }
            filter { includeGroupByRegex("com\\.github\\.termux.*") }
        }
    }
}

rootProject.name = "optio-android"

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

include(":app")

include(
    ":core:model",
    ":core:network",
    ":core:data",
    ":core:navigation",
    ":core:ui",
    ":core:terminal",
    ":core:testing",
    ":core:workfeed",
    ":core:glance",
)

include(
    ":feature:auth",
    ":feature:overview",
    ":feature:work",
    ":feature:workform",
    ":feature:tasks",
    ":feature:reviews",
    ":feature:insights",
    ":feature:local",
    ":feature:agents",
    ":feature:sessions",
    ":feature:library",
    ":feature:more",
    ":feature:glance",
    ":feature:widgets",
)
