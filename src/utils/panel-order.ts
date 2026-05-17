/**
 * Pure resolvers that turn the user's stored (sparse) order arrays into
 * concrete render order, using the panel registry as the fallback source.
 *
 * Sparse semantics: stored array is the user-customized prefix. Any id
 * NOT in the stored array falls back to its position in the registry,
 * appended after the customized ids. Registry ids that exist but weren't
 * in stored are auto-added in registry order — so a new panel shipped
 * after the user customized still appears for them, no reset required.
 *
 * Spec: docs/superpowers/specs/panel-reordering-2026-05-17.md
 */
import type { PanelRegistryEntry } from '../constants/panel-registry.js';

/**
 * Resolves group render order.
 *
 * Stored group ids that are not in `registryGroups` are silently dropped
 * (a group can be removed from the codebase without forcing every user
 * to reset). Stored ids preserve their order; unknown registry ids are
 * appended in registry order.
 */
export function resolveGroupOrder(
  stored: readonly string[],
  registryGroups: readonly string[],
): string[] {
  const registrySet = new Set(registryGroups);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const g of stored) {
    if (!registrySet.has(g) || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  for (const g of registryGroups) {
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

/**
 * Resolves per-group panel render order.
 *
 * Only emits panel ids whose registry entry belongs to `group`. If the
 * stored array drifts to include ids from a different group (defensive),
 * they're filtered out here rather than rendering them in the wrong
 * section. Registry order is the tiebreaker for unfiled ids.
 */
export function resolvePanelOrder(
  stored: readonly string[],
  registry: readonly PanelRegistryEntry[],
  group: string,
): string[] {
  const inGroup = registry.filter((e) => e.group === group);
  const inGroupIds = new Set(inGroup.map((e) => e.id));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of stored) {
    if (!inGroupIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const entry of inGroup) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.id);
  }
  return out;
}
