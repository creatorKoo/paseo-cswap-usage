// Host-scoped settings, registered by the server entry and read with useSettings on the
// client. Shared code: Zod and plain values only.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * What the composer pill label carries after its 5h/7d gauge icon. The alias always comes
 * last, so a long one is what the host's one-line ellipsis cuts.
 * - `5h`: 5h percent and time to reset, e.g. `42% 2h31m · skt`
 * - `5h-7d`: 5h and 7d percent, e.g. `42% / 14% · skt`
 * - `short`: 5h percent only, e.g. `42% · skt`
 */
export const LABEL_FORMATS = ["5h", "5h-7d", "short"] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

export const pillSettings = defineSettings({
  id: "pill",
  scope: "host",
  version: 1,
  schema: z.object({
    labelFormat: z.enum(LABEL_FORMATS).default("5h"),
  }),
});

export const DEFAULT_LABEL_FORMAT: LabelFormat = "5h";

/** What each format looks like, minus the alias. Used where there is no live account. */
export const LABEL_EXAMPLES: Record<LabelFormat, string> = {
  "5h": "42% 2h31m",
  "5h-7d": "42% / 14%",
  short: "42%",
};
