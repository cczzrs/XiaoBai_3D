import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

export const projectRoot = new URL('../', import.meta.url);
const layout = JSON.parse(readFileSync(new URL('docs/project-layout.json', projectRoot), 'utf8'));
const moves = [...layout.moves].sort((a, b) => b.from.length - a.from.length);

/** Original approvals keep their paths and hashes; resolve their current locations here. */
export function resolveHistoricalPath(path) {
  const relative = path.replace(/^\.\//, '');
  const move = moves.find(({ from }) => from.endsWith('/') ? relative.startsWith(from) : relative === from);
  return move ? move.to + relative.slice(move.from.length) : relative;
}

export function historicalURL(path) {
  return new URL(resolveHistoricalPath(path), projectRoot);
}

/** Re-creatable output belongs under temp, including on a clean checkout. */
export async function temporaryOutput(path) {
  const target = new URL(`temp/${path}`, projectRoot);
  await mkdir(new URL('.', target), { recursive: true });
  return target;
}
