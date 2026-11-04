// Asset/cache keys retain their original names to reuse verified local weights.
// Two concrete processors; neither selects or falls back to another checkpoint.
export const TEXT_SUMMARY_TYPES = ['TextSummaryLfm2', 'TextSummaryQwen35'];
export function textSummaryModel(type) {
  if (type === 'TextSummaryLfm2') return {
    id: 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX', revision: '01b5a0a33d22253d5ee52b367d2375eeb113b7cd',
    dtype: 'q4f16', device: 'webgpu', key: 'meeting-summary-lfm2', label: 'Text Summary · LFM2.5 1.2B JP',
  };
  if (type === 'TextSummaryQwen35') return {
    id: 'onnx-community/Qwen3.5-2B-ONNX-OPT', revision: 'ed446636739bf426e73c5a00714fd8e010d36c21',
    dtype: 'q4f16', device: 'webgpu', key: 'meeting-summary-qwen35', label: 'Text Summary · Qwen3.5 2B',
  };
  throw new TypeError('Unknown text summary processor.');
}
