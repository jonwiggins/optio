package dev.optio.core.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.parseMarkdown
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.semibold

/**
 * Markdown prose in the app's type and colours (agent replies, message bubbles, descriptions), via
 * the mikepenz renderer. Parsed synchronously, so it is safe inside lazy lists and screenshots; the
 * parse is cached per [markdown] string. Links open through `LocalUriHandler`.
 */
@Composable
fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier,
    style: TextStyle = OptioTheme.type.body,
    color: Color = OptioTheme.colors.label,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val parsed = remember(markdown) { parseMarkdown(markdown) }
    val body = style.copy(color = color)
    Markdown(
        state = parsed,
        colors = markdownColor(
            text = color,
            codeBackground = colors.fillTertiary,
            inlineCodeBackground = colors.fillTertiary,
            dividerColor = colors.separator,
            tableBackground = colors.fillQuaternary,
        ),
        typography = markdownTypography(
            h1 = type.title2.semibold().copy(color = color),
            h2 = type.title3.semibold().copy(color = color),
            h3 = type.headline.copy(color = color),
            h4 = type.headline.copy(color = color),
            h5 = type.subheadline.semibold().copy(color = color),
            h6 = type.subheadline.semibold().copy(color = colors.secondaryLabel),
            text = body,
            code = type.monoFootnote.copy(color = color),
            inlineCode = style.copy(fontFamily = type.monoSubheadline.fontFamily, fontSize = style.fontSize * 0.88f, color = color),
            quote = body.copy(fontStyle = FontStyle.Italic, color = colors.secondaryLabel),
            paragraph = body,
            ordered = body,
            bullet = body,
            list = body,
            textLink = TextLinkStyles(SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline)),
            table = type.footnote.copy(color = color),
            alertTitle = type.subheadline.semibold().copy(color = color),
        ),
        modifier = modifier,
    )
}
