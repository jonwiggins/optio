package dev.optio.core.model

/** JSON payloads under `src/test/resources/fixtures/`, shaped like the API's responses. */
internal object Fixtures {
    fun text(name: String): String =
        checkNotNull(Fixtures::class.java.getResource("/fixtures/$name")) { "missing fixture $name" }
            .readText()

    inline fun <reified T> decode(name: String): T = OptioJson.decodeFromString<T>(text(name))
}
