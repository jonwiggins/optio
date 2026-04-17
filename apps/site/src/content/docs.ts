export interface DocPage {
  title: string;
  href: string;
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

export const docsNav: DocSection[] = [
  {
    title: "Getting Started",
    pages: [
      { title: "Introduction", href: "/docs/getting-started" },
      { title: "Installation", href: "/docs/installation" },
      { title: "Configuration", href: "/docs/configuration" },
    ],
  },
  {
    title: "Core Concepts",
    pages: [
      { title: "Architecture", href: "/docs/architecture" },
      { title: "Task Lifecycle", href: "/docs/task-lifecycle" },
    ],
  },
  {
    title: "Guides",
    pages: [
      { title: "Creating Tasks", href: "/docs/guides/creating-tasks" },
      { title: "Standalone Tasks", href: "/docs/guides/standalone-tasks" },
      { title: "Scheduled Tasks", href: "/docs/guides/scheduled-tasks" },
      { title: "Connecting Repos", href: "/docs/guides/connecting-repos" },
      { title: "Review Agents", href: "/docs/guides/review-agents" },
      { title: "Integrations", href: "/docs/guides/integrations" },
      { title: "Connections", href: "/docs/guides/connections" },
    ],
  },
  {
    title: "Reference",
    pages: [
      { title: "API Reference", href: "/docs/api-reference" },
      { title: "Deployment", href: "/docs/deployment" },
      { title: "Contributing", href: "/docs/contributing" },
    ],
  },
];
