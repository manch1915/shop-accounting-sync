import type { CatalogProduct } from '../domain/models.js';

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

function skuStem(sku: string): string {
  return sku.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Cheap ranking for "did you mean": word overlap of names plus a bonus when SKUs share a prefix,
 * which catches the usual case of a renamed variant (ZP-ETH-250 vs ZP-ETH-250G).
 */
export function rankCandidates(catalog: CatalogProduct[], name: string, sku: string) {
  const wanted = tokens(name);
  const stem = skuStem(sku);
  return catalog
    .filter((p) => !p.archived)
    .map((p) => {
      const have = tokens(p.name);
      const shared = [...wanted].filter((t) => have.has(t)).length;
      const nameScore = wanted.size === 0 ? 0 : shared / Math.max(wanted.size, have.size);
      const other = skuStem(p.sku ?? '');
      let prefix = 0;
      while (prefix < Math.min(stem.length, other.length) && stem[prefix] === other[prefix]) prefix++;
      const skuScore = stem.length === 0 ? 0 : prefix / Math.max(stem.length, other.length);
      return {
        externalId: p.externalId,
        label: p.name,
        hint: p.sku,
        score: Math.round((nameScore * 0.6 + skuScore * 0.4) * 100) / 100,
      };
    })
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score);
}
