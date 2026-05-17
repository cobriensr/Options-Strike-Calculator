import { z } from 'zod';

/**
 * Panel id regex — matches the `sec-*` convention used by 29 of 30
 * registered panels, plus the literal `results` id (the registry's one
 * non-prefixed entry, see src/constants/panel-registry.ts:170).
 */
const panelIdSchema = z
  .string()
  .regex(/^(sec-[a-z0-9-]+|results)$/, 'Panel id must be sec-* or results');

/**
 * Group name enum mirrors PanelGroup from src/constants/panel-registry.ts.
 * Kept in sync manually — there are only 6 groups and the file is
 * already cross-referenced by the modal + this validator.
 */
const groupNameSchema = z.enum([
  'Inputs',
  'Market Context',
  'Futures',
  'Charts & History',
  'Trading',
  'Results',
]);

/**
 * Reject arrays with duplicate ids — the resolver assumes ordered ids
 * are unique and silently dropping duplicates would mask client bugs.
 */
function uniqueIds(arr: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const id of arr) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate id: ${id}`,
      });
      return;
    }
    seen.add(id);
  }
}

export const panelPrefsBodySchema = z.object({
  hiddenPanels: z
    .array(panelIdSchema)
    .max(50, 'Too many hidden panels')
    .superRefine(uniqueIds)
    .optional(),
  panelOrder: z
    .array(panelIdSchema)
    .max(50, 'Too many panel ids in order')
    .superRefine(uniqueIds)
    .optional(),
  groupOrder: z
    .array(groupNameSchema)
    .max(20, 'Too many group ids in order')
    .superRefine(uniqueIds)
    .optional(),
});

export type PanelPrefsBody = z.infer<typeof panelPrefsBodySchema>;
