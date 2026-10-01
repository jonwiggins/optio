package dev.optio.core.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.ui.theme.OptioTheme
import java.net.URI

// Brand marks for the things work comes from and links to (GitHub, GitLab, Slack, Linear, Jira,
// Notion, Sentry), the agent runtimes ([AgentBrand]: Claude, OpenAI, Copilot, Gemini, Cursor, OpenCode)
// plus GitHub's pull-request and issue glyphs: the Android twin of iOS
// `BrandMark.swift` and the web's `components/brand-icon.tsx`. Brand paths are Simple Icons (CC0),
// PR / issue glyphs GitHub Primer Octicons (MIT), inlined as SVG path data. Every mark is a
// single-colour ImageVector, so it takes `Icon`'s tint like a Material icon: brand marks draw in
// the content colour, never a brand colour (Slack's four, Claude's orange). Only PR / issue glyphs
// carry a colour, and that is state, not brand.

/** One-colour vector from SVG path data on a square [viewport] grid (24 for Simple Icons, 16 for Octicons). */
private fun mono(name: String, viewport: Float, vararg d: String): ImageVector {
    val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = viewport, viewportHeight = viewport)
    d.forEach { b.addPath(pathData = addPathNodes(it), fill = SolidColor(Color.Black)) }
    return b.build()
}

private const val SLACK_BLUE = "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
private const val SLACK_GREEN = "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
private const val SLACK_YELLOW = "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
private const val SLACK_RED = "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"

/** The marks as ImageVectors, for any `Icon(imageVector = …)` slot (menus, chips, rows). */
object BrandIcons {
    val GitHub: ImageVector by lazy {
        mono(
            "GitHub", 24f,
            "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
        )
    }
    val GitLab: ImageVector by lazy {
        mono(
            "GitLab", 24f,
            "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
        )
    }

    /** Slack's mark in one colour (Simple Icons' path; takes the tint). */
    val Slack: ImageVector by lazy { mono("Slack", 24f, SLACK_RED, SLACK_BLUE, SLACK_GREEN, SLACK_YELLOW) }
    val Linear: ImageVector by lazy {
        mono(
            "Linear", 24f,
            "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
        )
    }
    val Jira: ImageVector by lazy {
        mono(
            "Jira", 24f,
            "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
        )
    }
    val Notion: ImageVector by lazy {
        mono(
            "Notion", 24f,
            "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
        )
    }
    val Sentry: ImageVector by lazy {
        mono(
            "Sentry", 24f,
            "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
        )
    }

    val PullRequestOpen: ImageVector by lazy {
        mono(
            "PullRequestOpen", 16f,
            "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
        )
    }
    val PullRequestMerged: ImageVector by lazy {
        mono(
            "PullRequestMerged", 16f,
            "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
        )
    }
    val PullRequestClosed: ImageVector by lazy {
        mono(
            "PullRequestClosed", 16f,
            "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
        )
    }
    val PullRequestDraft: ImageVector by lazy {
        mono(
            "PullRequestDraft", 16f,
            "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
        )
    }
    val IssueOpen: ImageVector by lazy {
        mono(
            "IssueOpen", 16f,
            "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
            "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
        )
    }
    val IssueClosed: ImageVector by lazy {
        mono(
            "IssueClosed", 16f,
            "M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z",
            "M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z",
        )
    }

    // Agent runtimes (Simple Icons, CC0; OpenAI from simple-icons 15.0.0, dropped from later releases).
    val Claude: ImageVector by lazy {
        mono(
            "Claude", 24f,
            "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
        )
    }
    val OpenAI: ImageVector by lazy {
        mono(
            "OpenAI", 24f,
            "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
        )
    }
    val GitHubCopilot: ImageVector by lazy {
        mono(
            "GitHubCopilot", 24f,
            "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z",
        )
    }
    val Gemini: ImageVector by lazy {
        mono(
            "Gemini", 24f,
            "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
        )
    }
    val Cursor: ImageVector by lazy {
        mono(
            "Cursor", 24f,
            "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
        )
    }
    val OpenCode: ImageVector by lazy {
        mono(
            "OpenCode", 24f,
            "M22 24H2V0h20zM17 4.8H7v14.4h10z",
        )
    }
}

/** A service we draw the logo of. */
enum class Brand(val label: String) {
    GitHub("GitHub"),
    GitLab("GitLab"),
    Slack("Slack"),
    Linear("Linear"),
    Jira("Jira"),
    Notion("Notion"),
    Sentry("Sentry"),
    ;

    /** The one-colour mark, for tinted `Icon` slots. */
    val icon: ImageVector
        get() = when (this) {
            GitHub -> BrandIcons.GitHub
            GitLab -> BrandIcons.GitLab
            Slack -> BrandIcons.Slack
            Linear -> BrandIcons.Linear
            Jira -> BrandIcons.Jira
            Notion -> BrandIcons.Notion
            Sentry -> BrandIcons.Sentry
        }

    companion object {
        /** A provider / source string ("github", "GitLab", "linear", …) → its brand, if we have one. */
        fun fromProvider(provider: String?): Brand? {
            val p = provider?.trim()?.lowercase() ?: return null
            return entries.firstOrNull { it.name.lowercase() == p }
        }

        /** The host a URL lives on → its brand (github.com, gitlab.*, linear.app, *.atlassian.net, …). */
        fun fromUrl(url: String?): Brand? {
            val host = url?.let { runCatching { URI(it.trim()).host }.getOrNull() }?.lowercase() ?: return null
            return when {
                host.endsWith("github.com") -> GitHub
                "gitlab" in host -> GitLab
                host.endsWith("linear.app") -> Linear
                host.endsWith("atlassian.net") || "jira" in host -> Jira
                host.endsWith("notion.so") || host.endsWith("notion.site") -> Notion
                host.endsWith("slack.com") -> Slack
                host.endsWith("sentry.io") -> Sentry
                else -> null
            }
        }
    }
}

/** Pull-request state as the glyph shows it (GitHub's colours). */
enum class PrGlyphState(val label: String) {
    OPEN("Open pull request"),
    MERGED("Merged pull request"),
    CLOSED("Closed pull request"),
    DRAFT("Draft pull request"),
    ;

    val icon: ImageVector
        get() = when (this) {
            OPEN -> BrandIcons.PullRequestOpen
            MERGED -> BrandIcons.PullRequestMerged
            CLOSED -> BrandIcons.PullRequestClosed
            DRAFT -> BrandIcons.PullRequestDraft
        }

    /** Green open, purple merged, red closed, grey draft. */
    val color: Color
        @Composable @ReadOnlyComposable get() = when (this) {
            OPEN -> OptioTheme.colors.green
            MERGED -> MergedPurple
            CLOSED -> OptioTheme.colors.red
            DRAFT -> OptioTheme.colors.secondaryLabel
        }

    companion object {
        /** Normalize the PR state strings the API returns (`merged`, `closed`, `draft`, …). Unknown → open. */
        fun from(state: String?, merged: Boolean = false): PrGlyphState = when {
            merged -> MERGED
            else -> when (state?.lowercase()) {
                "merged" -> MERGED
                "closed", "declined" -> CLOSED
                "draft" -> DRAFT
                else -> OPEN
            }
        }
    }
}

/** GitHub's merged / closed-issue purple. */
val MergedPurple = Color(0xFF8957E5)

/**
 * A brand's logo at [size], in [tint] (the content colour by default). [contentDescription]
 * defaults to the brand's name; pass null when a text label already names it.
 */
@Composable
fun BrandMark(
    brand: Brand,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    contentDescription: String? = brand.label,
    tint: Color = LocalContentColor.current,
) {
    Icon(brand.icon, contentDescription = contentDescription, tint = tint, modifier = modifier.size(size))
}

/** A pull-request glyph in its state's colour ("Open pull request", … for accessibility). */
@Composable
fun PrGlyph(
    state: PrGlyphState,
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    contentDescription: String? = state.label,
    tint: Color = state.color,
) {
    Icon(state.icon, contentDescription = contentDescription, tint = tint, modifier = modifier.size(size))
}

/** An issue glyph: green open, purple closed. */
@Composable
fun IssueGlyph(
    open: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    contentDescription: String? = if (open) "Open issue" else "Closed issue",
    tint: Color = if (open) OptioTheme.colors.green else MergedPurple,
) {
    Icon(if (open) BrandIcons.IssueOpen else BrandIcons.IssueClosed, contentDescription = contentDescription, tint = tint, modifier = modifier.size(size))
}

/**
 * The brand a trigger listens to: `github` / `slack` / `linear` events, and a `ticket` trigger's
 * provider ([source], e.g. "github", "jira"). Null for manual / schedule / webhook.
 */
fun triggerBrand(type: String?, source: String? = null): Brand? = when (type?.lowercase()) {
    "github" -> Brand.GitHub
    "slack" -> Brand.Slack
    "linear" -> Brand.Linear
    "ticket" -> Brand.fromProvider(source)
    else -> null
}

/**
 * A trigger type → its icon: the event triggers (and a ticket trigger with a known provider) show
 * the brand they listen to; manual / schedule / webhook / ticket keep their Material icons.
 */
fun triggerIcon(type: String?, source: String? = null): ImageVector = triggerBrand(type, source)?.icon ?: when (type?.lowercase()) {
    "manual" -> Icons.Outlined.TouchApp
    "schedule" -> Icons.Outlined.Schedule
    "webhook" -> Icons.Outlined.Webhook
    "ticket" -> Icons.Outlined.ConfirmationNumber
    else -> Icons.Outlined.Bolt
}

/**
 * A trigger's icon as a composable: the brand mark for brand triggers, the
 * Material icon otherwise, tinted [tint]. Decorative unless [contentDescription] is given.
 */
@Composable
fun TriggerIcon(
    type: String?,
    modifier: Modifier = Modifier,
    source: String? = null,
    size: Dp = 16.dp,
    tint: Color = LocalContentColor.current,
    contentDescription: String? = null,
) {
    val brand = triggerBrand(type, source)
    if (brand != null) {
        BrandMark(brand, modifier, size = size, contentDescription = contentDescription, tint = tint)
    } else {
        Icon(
            triggerIcon(type, source),
            contentDescription = contentDescription,
            tint = tint,
            modifier = modifier.size(size),
        )
    }
}

/** A ticket source string → the [WorkLinkProvider] its link badge wears. */
fun workLinkProvider(source: String?): WorkLinkProvider = when (source?.lowercase()) {
    "gitlab" -> WorkLinkProvider.GITLAB
    "linear" -> WorkLinkProvider.LINEAR
    "jira" -> WorkLinkProvider.JIRA
    else -> WorkLinkProvider.GITHUB
}

/**
 * The mark a PR / ticket link wears: the pull-request glyph for a PR, a Linear / Jira ticket's
 * logo, the issue glyph for a GitHub / GitLab issue, a hash for a bare `#123` reference.
 */
val WorkLink.glyph: ImageVector
    get() = when (kind) {
        WorkLinkKind.PR -> BrandIcons.PullRequestOpen
        WorkLinkKind.REF -> Icons.Outlined.Tag
        else -> when (provider) {
            WorkLinkProvider.LINEAR -> BrandIcons.Linear
            WorkLinkProvider.JIRA -> BrandIcons.Jira
            else -> BrandIcons.IssueOpen
        }
    }

/**
 * An agent runtime we know (`agentType` / `agentRuntime` / a local terminal's `spec.agent`), with
 * its logo where Simple Icons has one. OpenClaw has no published simple mark, so it draws a neutral
 * robot rather than an invented logo.
 */
enum class AgentBrand(val runtime: String, val label: String) {
    ClaudeCode("claude-code", "Claude Code"),
    Codex("codex", "OpenAI Codex"),
    Copilot("copilot", "GitHub Copilot"),
    Gemini("gemini", "Google Gemini"),
    Cursor("cursor", "Cursor"),
    OpenCode("opencode", "OpenCode"),
    OpenClaw("openclaw", "OpenClaw"),
    ;

    /** The runtime's mark (Claude, OpenAI, Copilot, Gemini, Cursor, OpenCode); a neutral robot for OpenClaw. */
    val icon: ImageVector
        get() = when (this) {
            ClaudeCode -> BrandIcons.Claude
            Codex -> BrandIcons.OpenAI
            Copilot -> BrandIcons.GitHubCopilot
            Gemini -> BrandIcons.Gemini
            Cursor -> BrandIcons.Cursor
            OpenCode -> BrandIcons.OpenCode
            OpenClaw -> Icons.Outlined.SmartToy
        }

    companion object {
        /** A runtime id ("claude-code", "codex", …; "claude" too) → its brand, if we know it. */
        fun from(runtime: String?): AgentBrand? {
            val r = runtime?.trim()?.lowercase() ?: return null
            if (r == "claude") return ClaudeCode
            return entries.firstOrNull { it.runtime == r }
        }
    }
}

/**
 * A runtime id → its icon: the agent's logo, a terminal for a plain shell (`""` / "terminal" /
 * "shell"), a neutral robot for an agent we don't know.
 */
fun agentIcon(runtime: String?): ImageVector {
    AgentBrand.from(runtime)?.let { return it.icon }
    return when (runtime?.trim()?.lowercase()) {
        null, "", "terminal", "shell" -> Icons.Outlined.Terminal
        else -> Icons.Outlined.SmartToy
    }
}

/**
 * An agent runtime's logo at [size], tinted like a Material icon. [contentDescription] defaults to
 * the runtime's name; pass null when a text label beside it already names the agent.
 */
@Composable
fun AgentMark(
    runtime: String?,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    contentDescription: String? = AgentBrand.from(runtime)?.label ?: runtime?.takeIf { it.isNotBlank() } ?: "Terminal",
    tint: Color = LocalContentColor.current,
) {
    Icon(agentIcon(runtime), contentDescription = contentDescription, tint = tint, modifier = modifier.size(size))
}
