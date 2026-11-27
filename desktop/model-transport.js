// Initial requests must match a pin exactly. Hugging Face resolves immutable
// files through its LFS/Xet CDN with expiring signed redirect URLs.
function allowedRedirect(from, to) {
  return to.protocol === 'https:' && !to.username && !to.password && !to.port && !to.hash
    && (from.hostname === to.hostname || (from.hostname === 'huggingface.co'
      && (to.hostname.endsWith('.huggingface.co') || to.hostname.endsWith('.hf.co'))));
}

export async function fetchPinnedModelAsset(request, sources, signal, fetchAsset = fetch) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  if (request.method !== 'GET' || url.search !== `?source=${encodeURIComponent(source)}` || !sources.has(source) || !signal) {
    return new Response(null, { status: 404 });
  }
  try {
    let upstream = new URL(source);
    for (let remaining = 5; remaining > 0; remaining--) {
      const response = await fetchAsset(upstream, {
        redirect: 'manual', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([signal, request.signal]),
      });
      if (response.status === 200 && response.body) {
        return new Response(response.body, { headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(sources.get(source)),
          'Cross-Origin-Resource-Policy': 'same-origin',
        } });
      }
      await response.body?.cancel();
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return new Response(null, { status: response.status >= 400 ? response.status : 502 });
      }
      const location = response.headers.get('Location');
      if (!location) break;
      const next = new URL(location, upstream);
      if (!allowedRedirect(upstream, next)) break;
      upstream = next;
    }
  } catch { /* Keep signed redirect URLs and upstream error details private. */ }
  return new Response(null, { status: 502 });
}
