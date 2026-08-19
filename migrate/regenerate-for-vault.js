#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { expandHome } = require('../lib/router-core.js');
const { generateManifest } = require('../lib/generate-manifest.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function regenerate(vault, output, { sourceRoot } = {}) {
  const root = path.resolve(expandHome(vault));
  const generatorLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(' '));
  let manifest;
  try { manifest = generateManifest([root]); }
  finally { console.log = generatorLog; }
  if (sourceRoot) {
    const finalRoot = path.resolve(expandHome(sourceRoot));
    manifest.skills = manifest.skills.map(skill => ({ ...skill, source_root: finalRoot }));
  }
  const out = path.resolve(expandHome(String(output)));
  const liveManifest = path.join(root, '.router', 'manifest.json');
  if (path.resolve(out) === path.resolve(liveManifest)) throw new Error('Refusing to overwrite the vault live manifest; choose a separate output path');
  if (fs.existsSync(out)) throw new Error(`Refusing to overwrite existing manifest: ${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { output: out, vault: root, skillCount: manifest.skills.length, warnings: logs.filter(line => /warn|error/i.test(line)) };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.vault || !args.out) throw new Error('Usage: node regenerate-for-vault.js --vault <path> --out <manifest.json>');
    process.stdout.write(`${JSON.stringify(regenerate(args.vault, args.out), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`regenerate-for-vault failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { regenerate, parseArgs };
