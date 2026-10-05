import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const files = [
  'bridge/README.md',
  'bridge/windows/README.ru.md',
  'bridge/windows/setup.mjs',
  'docs/installation.en.md',
  'docs/installation.ru.md',
  'docs/troubleshooting.md',
];

test('installation commands use the pinned bridge Wrangler version', async () => {
  const {devDependencies} = JSON.parse(await readFile(new URL('../bridge/package.json', import.meta.url), 'utf8'));
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const pins = [...source.matchAll(/--package=wrangler@([^\s'"`]+)/g)];
    assert.ok(pins.length > 0, `No Wrangler command found in ${file}`);
    for (const [, version] of pins) assert.equal(version, devDependencies.wrangler, file);
  }
});
