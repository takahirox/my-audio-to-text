// Two concrete processors; neither selects or falls back to another checkpoint.
export const MEETING_SUMMARY_TYPES = ['MeetingSummaryLfm2', 'MeetingSummaryQwen35'];
export function meetingSummaryModel(type) {
  if (type === 'MeetingSummaryLfm2') return {
    id: 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX', revision: '01b5a0a33d22253d5ee52b367d2375eeb113b7cd',
    dtype: 'q4f16', device: 'webgpu', key: 'meeting-summary-lfm2', label: 'Meeting Summary · LFM2.5 1.2B JP',
  };
  if (type === 'MeetingSummaryQwen35') return {
    id: 'onnx-community/Qwen3.5-2B-ONNX-OPT', revision: 'ed446636739bf426e73c5a00714fd8e010d36c21',
    dtype: 'q4f16', device: 'webgpu', key: 'meeting-summary-qwen35', label: 'Meeting Summary · Qwen3.5 2B',
  };
  throw new TypeError('Unknown meeting summary processor.');
}
