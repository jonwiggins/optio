package dev.optio.feature.local.transcript

import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.model.LocalTranscriptKind
import dev.optio.core.model.LocalTranscriptRole
import dev.optio.core.model.LocalTranscriptSource
import kotlinx.serialization.json.*

/** Async user-message questions; blocking request_user_input uses a different RPC. */
object CodexQuestions {
    data class Question(val id: String, val title: String, val options: List<String>)
    data class Reply(val answer: String, val question: String, val questionItemId: String)
    private const val OPEN = "<send_user_message_question_reply>"
    private const val CLOSE = "</send_user_message_question_reply>"
    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun pending(entries: List<LocalTranscriptEntry>): List<Question> {
        val questions = linkedMapOf<String, Question>()
        val answered = mutableSetOf<String>()
        for (entry in entries) {
            if (entry.role == LocalTranscriptRole.SYSTEM && entry.source == LocalTranscriptSource.REWIND) {
                questions.clear(); answered.clear()
            }
            if (entry.kind == LocalTranscriptKind.TOOL_USE && entry.toolName == "request_user_input_async" && !entry.toolUseId.isNullOrEmpty()) {
                val parsed = runCatching {
                    val values = Json.parseToJsonElement(entry.detail ?: "").jsonObject["questions"]!!.jsonArray
                    values.mapIndexed { index, value ->
                        val q = value.jsonObject
                        val title = q["title"].string()!!.also { require(it.isNotBlank()) }
                        val options = when (val opts = q["options"]) {
                            null, JsonNull -> emptyList()
                            else -> opts.jsonArray.map { it.string()!!.also { text -> require(text.isNotBlank()) } }
                        }
                        val id = buildJsonArray { add("request_user_input_async"); add(entry.toolUseId); add(index) }.toString()
                        Question(id, title, options)
                    }
                }.getOrDefault(emptyList())
                parsed.forEach { questions.putIfAbsent(it.id, it) }
            }
            if (entry.role == LocalTranscriptRole.USER) {
                replies(entry.text)?.forEach { reply ->
                    if (questions[reply.questionItemId]?.title == reply.question) answered += reply.questionItemId
                }
            }
        }
        return questions.values.filter { it.id !in answered }
    }

    fun replies(text: String): List<Reply>? {
        val body = text.trim()
        if (!body.startsWith(OPEN) || !body.endsWith(CLOSE) || body.length < OPEN.length + CLOSE.length) return null
        return runCatching {
            Json.parseToJsonElement(body.substring(OPEN.length, body.length - CLOSE.length)).jsonArray.map {
                val r = it.jsonObject
                Reply(r["answer"].string()!!, r["question"].string()!!, r["questionItemId"].string()!!)
            }.takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    fun replyText(question: Question, answer: String): String = OPEN + buildJsonArray {
        add(buildJsonObject { put("answer", answer); put("question", question.title); put("questionItemId", question.id) })
    }.toString().replace("<", "\\u003c") + CLOSE

    fun displayText(text: String): String = replies(text)?.joinToString("\n\n") { "${it.question}\n${it.answer}" } ?: text
}
