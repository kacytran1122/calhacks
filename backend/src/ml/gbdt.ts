/**
 * Evaluates gradient-boosted trees exported from XGBoost (see backend/ml/notebooks).
 * Same rule as XGBoost: compare in float32, go left when x < threshold, and a missing
 * value follows the node's default direction. The notebook checks this logic against
 * XGBoost itself before export; tests/backend/price-models.test.ts checks it again here.
 */
export interface CompactTree {
  l: number[]; // left child index, -1 at a leaf
  r: number[];
  f: number[]; // feature index
  c: number[]; // split threshold, or the leaf value at a leaf
  d: number[]; // 1 = missing values go left
}

export interface CompactModel {
  base: number;
  trees: CompactTree[];
}

const f32 = Math.fround;

export function predictTrees(model: CompactModel, row: readonly number[]): number {
  const x = row.map((v) => (Number.isFinite(v) ? f32(v) : Number.NaN));
  let sum = model.base;
  for (const t of model.trees) {
    let n = 0;
    while (t.l[n] !== -1) {
      const v = x[t.f[n]!];
      if (v === undefined || Number.isNaN(v)) n = t.d[n] ? t.l[n]! : t.r[n]!;
      else n = v < f32(t.c[n]!) ? t.l[n]! : t.r[n]!;
    }
    sum += f32(t.c[n]!);
  }
  return sum;
}
