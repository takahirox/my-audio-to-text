import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Lifecycle tests control GPU Worker replies, but Live still checks/downloads
// real verified bytes before creating them. Keep these fixture assets packaged.
export async function writeSummaryAssetFixture(root, base) {
  const bytes = Buffer.from('controlled cached summary model');
  await writeFile(path.join(root, 'extension/live-model-fixture.bin'), bytes);
  const files = [{ path: 'weights.bin', bytes: bytes.length,
    sha256Chunks: [createHash('sha256').update(bytes).digest('hex')], sourceURL: base + 'live-model-fixture.bin' }];
  for (const key of ['meeting-summary-lfm2', 'meeting-summary-qwen35']) {
    await writeFile(path.join(root, `extension/${key}-assets.json`), JSON.stringify(files));
  }
}
