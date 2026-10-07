#!/usr/bin/env node
// Content parity gate (constitution VII): zh.json and en.json must have identical keys, no empty values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/i18n/', import.meta.url));
const load = (f) => JSON.parse(readFileSync(dir + f, 'utf8'));
const flat = (o, p = '', out = {}) => {
  if (Array.isArray(o)) o.forEach((v, i) => flat(v, `${p}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
  else out[p] = o;
  return out;
};
const zh = flat(load('zh.json'));
const en = flat(load('en.json'));
const problems = [];
for (const k of Object.keys(zh)) if (!(k in en)) problems.push(`en.json is missing "${k}"`);
for (const k of Object.keys(en)) if (!(k in zh)) problems.push(`zh.json is missing "${k}"`);
for (const [name, f] of [['zh.json', zh], ['en.json', en]])
  for (const [k, v] of Object.entries(f)) if (typeof v !== 'string' || !v.trim()) problems.push(`${name}: "${k}" is empty`);
if (problems.length) {
  console.error('✗ Content check failed:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`✓ Content check passed: ${Object.keys(zh).length} keys in each language`);
