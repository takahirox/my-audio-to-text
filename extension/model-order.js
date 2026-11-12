const titleCollator = new Intl.Collator('ja-JP', { usage: 'sort', sensitivity: 'base', numeric: true });
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Code-unit title and ID tie-breaks keep equivalent kana/case/numeric names
// deterministic regardless of the definitions' insertion order.
export const compareModelDefinitions = (a, b) => titleCollator.compare(a.title, b.title)
  || compareText(a.title, b.title) || compareText(a.id, b.id);
