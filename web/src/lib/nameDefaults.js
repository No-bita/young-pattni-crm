// Pre-select the name from the later row in the file for each conflicting number.
export function defaultNameChoices(conflicts) {
  const out = {};
  for (const group of conflicts || []) {
    const lastRow = c => (c.rows.length ? Math.max(...c.rows) : -1);
    const best = group.candidates.reduce((a, c) => (lastRow(c) > lastRow(a) ? c : a));
    out[group.phone] = { name: best.name, candidates: group.candidates.map(c => c.name) };
  }
  return out;
}
