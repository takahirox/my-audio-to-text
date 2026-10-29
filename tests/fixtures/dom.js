import { parseHTML } from 'linkedom';
// Unit tests exercise real native-like DOM ownership; visible layout is checked
// separately in browser engines and the packaged extension.
export const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;
export function domText(snapshot) {
  if (!snapshot) return '';
  const copy = snapshot.cloneNode(true);
  for (const style of copy.querySelectorAll?.('style') || []) style.remove();
  if (copy.querySelector?.('tbody')) return [...copy.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent).join('\n')).join('\n');
  return copy.textContent || [...copy.childNodes].map(node => node.textContent).join('');
}
