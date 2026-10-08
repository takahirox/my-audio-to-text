export function translationLabel(row) {
  if (!row || row.status === 'off') return 'Translation off';
  if (row.status === 'complete') return row.text;
  if (row.status === 'error') return `Translation failed: ${row.error}`;
  if (row.status === 'canceled') return 'Translation canceled';
  return 'Translating…';
}
export function provisionalLabel(original, row, enabled) {
  if (!enabled) return 'Translation off';
  if (!original) return '';
  if (!row) return 'Translating…';
  if (row.source.text !== original) return `Translating… Older interim: ${translationLabel(row)}\nOriginal for older translation: ${row.source.text}`;
  const label = translationLabel(row);
  return row.previous ? `${label}\nOlder interim: ${row.previous.text}\nOriginal for older translation: ${row.previous.source.text}` : label;
}

export function provisionalState(original, row, enabled) {
  if (!enabled) return 'off';
  if (!original) return 'empty';
  if (!row) return 'pending';
  return row.source.text === original ? row.status : 'stale';
}
