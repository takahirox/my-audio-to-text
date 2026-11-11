// Call only AFTER inference sessions exist: ORT's device getter can otherwise
// allocate a new device. Observe the device those sessions already own, without
// probing with inference or creating a second device. Worker termination owns
// final resource release.
export function watchGpuDevice(webgpu, onFailure) {
  if (!webgpu) return;
  Promise.resolve(webgpu.device).then(device => device?.lost?.then(info => {
    onFailure(Error(`GPU device lost: ${info.message || info.reason || 'device unavailable'}. Check hardware acceleration and free GPU memory, then Retry models in this window.`));
  })).catch(onFailure);
}
