import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://optio.host";

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];

  const docPages = [
    "/docs/getting-started",
    "/docs/installation",
    "/docs/configuration",
    "/docs/architecture",
    "/docs/task-lifecycle",
    "/docs/guides/creating-tasks",
    "/docs/guides/connecting-repos",
    "/docs/guides/review-agents",
    "/docs/guides/integrations",
    "/docs/guides/standalone-tasks",
    "/docs/guides/scheduled-tasks",
    "/docs/api-reference",
    "/docs/deployment",
    "/docs/contributing",
  ];

  const docEntries: MetadataRoute.Sitemap = docPages.map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...staticPages, ...docEntries];
}
