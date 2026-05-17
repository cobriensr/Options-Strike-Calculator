import { z } from 'zod';

export const panelPrefsBodySchema = z.object({
  hiddenPanels: z
    .array(
      z
        .string()
        .regex(/^sec-[a-z0-9-]+$/, 'Panel id must match sec-* convention'),
    )
    .max(50, 'Too many hidden panels'),
});

export type PanelPrefsBody = z.infer<typeof panelPrefsBodySchema>;
