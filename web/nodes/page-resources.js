// Attempt every release even if one resource's cleanup fails. Returning the
// error lets page controllers restore retry controls in every exit path.
export async function releaseResources(...resources) {
  const results = await Promise.allSettled(resources.map(resource => {
    try { return resource?.dispose(); } catch (error) { return Promise.reject(error); }
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  return failures.length ? new Error(`Resource release failed: ${failures.map(error => error.message || error).join('; ')}`) : null;
}
