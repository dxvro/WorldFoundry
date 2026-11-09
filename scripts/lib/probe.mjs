// Error text for a failed spawnSync call (pure logic).
// On a start failure (EACCES, ENOENT, ...) there is neither a status nor stdout/stderr, only result.error.
export function describeSpawnFailure(result) {
  const lines = [];
  if (result.error) {
    lines.push(`${result.error.message}${result.error.code ? ` (${result.error.code})` : ''}`);
  }
  if (result.signal) lines.push(`Terminated by signal ${result.signal}`);
  else if (result.status !== null && result.status !== undefined && result.status !== 0) lines.push(`Exit status ${result.status}`);
  for (const [label, value] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text !== '') lines.push(`${label}:\n${text}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'unknown error (no output, no status)';
}
