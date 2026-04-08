export async function openBrowser(url: string): Promise<void> {
  const open = await import("open");
  await open.default(url);
}
