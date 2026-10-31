// Patch only the reviewed Apache-2.0 conversion's attention-mask wiring.
// Weights and computation stay intact. Original bytes remain in the model cache.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const join = parts => {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; } return bytes;
};
const varint = n => { const bytes = []; do { bytes.push((n % 128) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Uint8Array.from(bytes); };
const field = (id, bytes) => join([varint(id * 8 + 2), varint(bytes.length), bytes]);
const string = (id, value) => field(id, encoder.encode(value));
const valueInfo = (name, type, shape) => {
  const dims = shape.map(d => field(1, typeof d === 'number' ? join([Uint8Array.of(8), varint(d)]) : string(2, d)));
  return join([string(1, name), field(2, field(1, join([Uint8Array.of(8, type), field(2, join(dims))])))]);
};
const nameOf = (parts, id) => decoder.decode(parts.find(p => p.id === id)?.data);
function fields(bytes) {
  let at = 0;
  const number = () => {
    let value = 0, factor = 1, count = 0;
    while (at < bytes.length && count++ < 10) { const b = bytes[at++]; value += (b & 127) * factor; if (b < 128) return value; factor *= 128; }
    throw Error('Invalid reviewed ONNX protobuf.');
  };
  const result = [];
  while (at < bytes.length) {
    const start = at, tag = number(), wire = tag % 8; let data;
    if (wire === 2) { const size = number(); data = bytes.subarray(at, at + size); at += size; }
    else if (wire === 0) number();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw Error('Unsupported reviewed ONNX wire type.');
    if (at > bytes.length) throw Error('Truncated reviewed ONNX protobuf.');
    result.push({ id: Math.floor(tag / 8), data, raw: bytes.subarray(start, at) });
  }
  return result;
}

export async function streamingCosyVoice3Flow(bytes) {
  // Do not silently patch another export with different mask semantics.
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== 'a56ab4d3654346a4da24d3b85211270a1fde5124fecd34a1d78d66cfe230058c') throw Error('Unreviewed CosyVoice3 flow export.');
  let replaced = 0, graphs = 0;
  const model = fields(bytes).map(part => {
    if (part.id !== 7) return part.raw;
    graphs++;
    const graph = fields(part.data).map(entry => {
      if (entry.id !== 1) return entry.raw;
      const node = fields(entry.data);
      const name = decoder.decode(node.find(p => p.id === 3)?.data);
      if (!/^\/estimator\/transformer_blocks\.(?:[0-9]|1[0-9]|2[01])\/attn\/Where$/.test(name)) return entry.raw;
      if (decoder.decode(node.find(p => p.id === 4)?.data) !== 'Where') throw Error('CosyVoice3 attention topology changed.');
      let input = 0;
      const patched = node.map(p => p.id === 1 && input++ === 0 ? string(1, 'streaming_mask') : p.raw);
      replaced++; return field(1, join(patched));
    });
    // ValueInfoProto → TypeProto.tensor_type → elem_type BOOL, shape [1,1,F,F].
    graph.push(field(11, valueInfo('streaming_mask', 9, [1, 1, 'frames', 'frames'])));
    return field(7, join(graph));
  });
  if (graphs !== 1 || replaced !== 22) throw Error('CosyVoice3 requires all 22 reviewed attention masks.');
  return join([...model, field(14, join([string(1, 'my-audio-to-text-modification'),
    string(2, 'Issue #172: expose all 22 flow attention masks for trained 50-frame causal chunks; original weights unchanged.')]))]);
}

// The reviewed nearest Resize maps coordinates with a uint32 product in stock
// WebGPU ORT. Long HiFT prefixes overflow that product. Repeat integer samples
// by reshaping/tiling instead; this is exact nearest-neighbor upsampling.
export async function streamingCosyVoice3Hift(bytes) {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== '5b9f5bc83053523c19e446b64050582f43e729dbc182ea7b38258ca2b7c89ed3') throw Error('Unreviewed CosyVoice3 HiFT export.');
  const node = (op, name, inputs, output) => field(1, join([...inputs.map(i => string(1, i)), string(2, output), string(3, name), string(4, op)]));
  const intTensor = (name, values) => {
    const raw = new Uint8Array(values.length * 8), view = new DataView(raw.buffer);
    values.forEach((v, i) => view.setBigInt64(i * 8, BigInt(v), true));
    return field(5, join([Uint8Array.of(8), varint(values.length), Uint8Array.of(16, 7), string(8, name), field(9, raw)]));
  };
  let replaced = 0;
  const model = fields(bytes).map(part => {
    if (part.id !== 7) return part.raw;
    const initializers = [];
    const graph = fields(part.data).map(entry => {
      if (entry.id !== 1) return entry.raw;
      const parts = fields(entry.data), name = nameOf(parts, 3);
      const match = /^\/ups\.([012])\/upsample\/Resize$/.exec(name);
      if (!match) return entry.raw;
      if (nameOf(parts, 4) !== 'Resize') throw Error('CosyVoice3 HiFT upsampling topology changed.');
      const index = Number(match[1]), scale = [8, 5, 3][index], channels = [512, 256, 128][index];
      const input = parts.find(p => p.id === 1), output = nameOf(parts, 2), base = `streaming_upsample_${index}`;
      initializers.push(intTensor(base + '_axis', [3]), intTensor(base + '_repeats', [1, 1, 1, scale]), intTensor(base + '_shape', [1, channels, -1]));
      replaced++;
      return join([
        node('Unsqueeze', base + '_unsqueeze', [decoder.decode(input.data), base + '_axis'], base + '_4d'),
        node('Tile', base + '_tile', [base + '_4d', base + '_repeats'], base + '_repeated'),
        node('Reshape', base + '_reshape', [base + '_repeated', base + '_shape'], output),
      ]);
    });
    return field(7, join([...graph, ...initializers]));
  });
  if (replaced !== 3) throw Error('CosyVoice3 requires all three reviewed HiFT upsamplers.');
  return join([...model, field(14, join([string(1, 'my-audio-to-text-modification'),
    string(2, 'Issue #172: replace three integer nearest Resize operations with equivalent reshape/tile upsampling; original weights unchanged.')]))]);
}

export function cosyVoice3Mask(frames) {
  if (!Number.isInteger(frames) || frames < 1 || frames > 1218) throw RangeError('CosyVoice3 flow prefix exceeds its bounded frame limit.');
  const mask = new Uint8Array(frames * frames);
  for (let row = 0; row < frames; row++) mask.fill(1, row * frames, row * frames + Math.min(frames, (Math.floor(row / 50) + 1) * 50));
  return mask;
}
