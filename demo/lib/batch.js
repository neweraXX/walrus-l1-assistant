// Missing indexes are safe only when every explicit index agrees with array order.
// Fully indexed arrays may arrive out of order and are reordered after validation.
export function normalizeBatch(raw, count, prediction) {
  const invalid = () => { throw Object.assign(new Error("Batch prediction service returned invalid indexes."), { status: 502, expose: true }); };
  if (!Array.isArray(raw) || raw.length !== count) return invalid();
  const indexes = raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return invalid();
    if (row.index === undefined) return undefined;
    const index = typeof row.index === "string" && /^\d+$/.test(row.index.trim()) ? Number(row.index.trim()) : row.index;
    if (!Number.isInteger(index) || index < 0 || index >= count) return invalid();
    return index;
  });
  const positional = indexes.includes(undefined);
  if (positional && indexes.some((index, position) => index !== undefined && index !== position)) return invalid();
  const resolved = indexes.map((index, position) => index ?? position);
  if (new Set(resolved).size !== count) return invalid();
  return raw.map((row, position) => ({ index: resolved[position], value: prediction(row) }))
    .sort((a, b) => a.index - b.index).map((row) => row.value);
}
