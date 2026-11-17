package dev.optio.feature.local.transcript

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.network.LocalApiClient
import dev.optio.feature.local.api.sendLocalTerminalInput
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun CodexQuestionCards(entries: List<LocalTranscriptEntry>, terminalId: String) {
    val questions = remember(entries) { CodexQuestions.pending(entries) }
    if (questions.isEmpty()) return
    Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questions.forEach { question -> key(question.id) { QuestionCard(question, terminalId) } }
    }
}

@Composable
private fun QuestionCard(question: CodexQuestions.Question, terminalId: String) {
    val api = LocalApiClient.current
    val scope = rememberCoroutineScope()
    var other by remember { mutableStateOf(false) }
    var value by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    fun send(answer: String) {
        if (sending || sent != null || answer.isBlank()) return
        sending = true; error = null
        scope.launch {
            try {
                api.sendLocalTerminalInput(terminalId, CodexQuestions.replyText(question, answer) + "\r")
                sent = answer
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) { error = e.message ?: "Couldn't send your answer. Try again."
            } finally { sending = false }
        }
    }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Question from Codex", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            Text(question.title, style = MaterialTheme.typography.bodyMedium)
            if (sent != null) {
                Text("Answer sent: $sent", style = MaterialTheme.typography.bodySmall)
            } else {
                question.options.forEach { option ->
                    OutlinedButton(onClick = { send(option) }, enabled = !sending, modifier = Modifier.fillMaxWidth()) { Text(option) }
                }
                if (question.options.isNotEmpty()) TextButton(onClick = { other = !other }, enabled = !sending) { Text("Other…") }
                if (other || question.options.isEmpty()) {
                    OutlinedTextField(value = value, onValueChange = { value = it }, label = { Text("Your answer") }, enabled = !sending, modifier = Modifier.fillMaxWidth())
                    Button(onClick = { send(value) }, enabled = !sending && value.isNotBlank()) { Text("Send answer") }
                }
                if (sending) Text("Sending answer…", style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}
