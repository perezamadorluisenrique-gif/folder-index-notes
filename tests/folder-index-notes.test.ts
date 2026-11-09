import test from 'node:test';
import assert from 'node:assert/strict';

import { END, START, applyBlock, buildBlock, indexFileName, isExcluded, parentOf, parseRules, sortItems, upToDate } from '../src/index-note.ts';

const item = (name: string) => ({ name, link: `[[${name}]]` });
const opts = { folders: [], notes: [], order: 'name' as const, foldersHeading: 'Folders', notesHeading: 'Notes' };

test('sortItems is natural and case-insensitive', () => {
  assert.deepEqual(sortItems([item('b'), item('A'), item('a10'), item('a2')], 'name').map((i) => i.name), ['A', 'a2', 'a10', 'b']);
  assert.deepEqual(sortItems([item('a'), item('b')], 'name-desc').map((i) => i.name), ['b', 'a']);
});

test('indexFileName fills the template and adds .md once', () => {
  assert.equal(indexFileName('Trips', '_Index of {{folder}}'), '_Index of Trips.md');
  assert.equal(indexFileName('Trips', '{{folder}}.md'), 'Trips.md');
  assert.equal(indexFileName('Trips', ''), '_Index of Trips.md');
});

test('buildBlock lists folders then notes under headings', () => {
  const b = buildBlock({ ...opts, folders: [item('Sub')], notes: [item('B'), item('A')] });
  assert.equal(b, [START, '## Folders', '', '- [[Sub]]', '', '## Notes', '', '- [[A]]', '- [[B]]', '', END].join('\n'));
});

test('buildBlock without headings and when empty', () => {
  assert.equal(buildBlock({ ...opts, notes: [item('A')], notesHeading: '' }), [START, '- [[A]]', '', END].join('\n'));
  assert.equal(buildBlock(opts), [START, '_Nothing here yet._', '', END].join('\n'));
});

test('applyBlock creates, replaces between markers and appends otherwise', () => {
  const block = buildBlock({ ...opts, notes: [item('A')] });
  assert.equal(applyBlock(null, block), `${block}\n`);
  const old = `intro\n${START}\nold\n${END}\noutro\n`;
  assert.equal(applyBlock(old, block), `intro\n${block}\noutro\n`);
  assert.equal(applyBlock('my words\n', block), `my words\n\n${block}\n`);
  assert.equal(applyBlock('', block), `${block}\n`);
});

test('applyBlock ignores an end marker that comes before the start', () => {
  const block = buildBlock(opts);
  const odd = `${END}\ntext\n${START}`;
  assert.ok(applyBlock(odd, block).startsWith(odd));
});

test('upToDate is true only after applying the same block', () => {
  const block = buildBlock({ ...opts, notes: [item('A')] });
  assert.equal(upToDate('x', block), false);
  assert.equal(upToDate(applyBlock('x', block), block), true);
});

test('isExcluded matches folders and subtrees', () => {
  assert.equal(isExcluded('Archive', ['Archive']), true);
  assert.equal(isExcluded('Archive/2020', ['Archive']), false);
  assert.equal(isExcluded('Archive/2020', ['Archive/*']), true);
  assert.equal(isExcluded('Archive', ['/Archive/*']), true);
  assert.equal(isExcluded('Other', ['Archive/*', '']), false);
});

test('parseRules and parentOf', () => {
  assert.deepEqual(parseRules(' a \n\nb/* \n'), ['a', 'b/*']);
  assert.equal(parentOf('a/b/c.md'), 'a/b');
  assert.equal(parentOf('c.md'), '');
});

test('a start marker left behind by a deleted end marker is not used', () => {
  const broken = `${START}\nmy notes\n`;
  const once = applyBlock(broken, `${START}\nA\n${END}`);
  const twice = applyBlock(once, `${START}\nB\n${END}`);
  assert.ok(twice.includes('my notes'));
  assert.ok(twice.includes('B'));
});

test('indexFileName removes characters a file name cannot hold', () => {
  assert.equal(indexFileName('Work', 'a/b:{{folder}}'), 'a-b-Work.md');
});
