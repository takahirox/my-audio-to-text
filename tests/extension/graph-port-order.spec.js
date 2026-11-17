import { test, openGraph } from './graph-fixture.js';
import { checkPortOrderAndInspector, checkPortGeometryAndInteractions } from '../fixtures/graph-port-order.js';

// Real MV3 editor, with small verified model manifests so Auto Save never
// downloads production weights while exercising layout and connection gestures.
test('MV3 data/ID ordering, keyboard selection, exact wire attachments and row gestures at multiple zooms', async ({ graphExtension: f }, info) => {
  test.setTimeout(120000);
  const host = await openGraph(f, { live: false }), page = host.editor;
  await checkPortOrderAndInspector(page);
  const measurements = await checkPortGeometryAndInteractions(page);
  await info.attach('MV3-port-order-crossings', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});
