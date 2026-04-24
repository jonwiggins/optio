import type { ProviderCatalog } from "./types.js";

export const GEMINI_CATALOG: ProviderCatalog = {
  provider: "gemini",
  label: "Google Gemini",
  modelField: "geminiModel",
  models: [
    {
      id: "gemini-2.0-flash",
      label: "Gemini 2.0 Flash",
      family: "gemini-flash",
      source: "baseline",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      family: "gemini-flash",
      source: "baseline",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      family: "gemini-pro",
      source: "baseline",
    },
    {
      id: "gemini-3-flash-preview",
      label: "Gemini 3 Flash (Preview)",
      family: "gemini-flash",
      preview: true,
      source: "baseline",
    },
    {
      id: "gemini-3-pro",
      label: "Gemini 3 Pro",
      family: "gemini-pro",
      latest: true,
      source: "baseline",
    },
    {
      id: "gemini-3.1-flash-lite-preview",
      label: "Gemini 3.1 Flash Lite (Preview)",
      family: "gemini-flash-lite",
      latest: true,
      preview: true,
      source: "baseline",
    },
    {
      id: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro (Preview)",
      family: "gemini-pro",
      preview: true,
      source: "baseline",
    },
  ],
  aliases: {
    "gemini-pro": "gemini-3-pro",
    "gemini-flash": "gemini-2.5-flash",
  },
  options: [
    {
      key: "geminiApprovalMode",
      label: "Approval Mode",
      kind: "select",
      default: "yolo",
      choices: [
        { value: "default", label: "Default" },
        { value: "auto_edit", label: "Auto Edit" },
        { value: "yolo", label: "Yolo (skip all approvals)" },
      ],
    },
  ],
  liveRefreshSupported: true,
};
