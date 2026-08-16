import type { ProviderCatalog } from "./types.js";

/**
 * Cursor CLI (`cursor-agent`) runs Cursor's Composer models plus the frontier
 * models available to the account (the set depends on the user's Cursor plan,
 * queryable with `cursor-agent models`). There is no public list-models HTTP
 * API, so the catalog carries a Composer baseline and accepts free text for
 * everything else.
 */
export const CURSOR_CATALOG: ProviderCatalog = {
  provider: "cursor",
  label: "Cursor",
  modelField: "cursorModel",
  modelIsFreeText: true,
  modelPlaceholder: "Default (Cursor auto-selects)",
  modelHelpText:
    "e.g. composer-2.5, composer-2, auto — run `cursor-agent models` to list the models available to your Cursor account",
  models: [],
  aliases: {},
  options: [],
  liveRefreshSupported: false,
};
