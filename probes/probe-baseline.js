#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome } = require('../lib/router-core.js');
function frontMatterByteLength(text) {
  if (!/^---(?:\r\n|\n)/.test(text)) return 0;
  const end = text.search(/\r?\n---(?:\r\n|\n|$)/);
  if (end < 0) return 0;
  const marker = text.slice(end).match(/^\r?\n---(?:\r\n|\n|$)/)[0];
  return Buffer.byteLength(text.slice(0, end + marker.length), 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function walk(root, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) walk(current, files);
    else if (entry.isFile() && entry.name === 'SKILL.md') files.push(current);
  }
  return files;
}

function measure(root) {
  const files = walk(root);
  let totalBytes = 0;
  let frontMatterBytes = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8');
    totalBytes += raw.length;
    frontMatterBytes += frontMatterByteLength(text);
  }
  return { root, recursive: true, skillMdCount: files.length, totalBytes, frontMatterBytes };
}

const args = parseArgs(process.argv.slice(2));
const roots = [
  args.zcode || path.join(os.homedir(), '.zcode', 'skills'),
  args.agents || path.join(os.homedir(), '.agents', 'skills')
];
const output = path.resolve(expandHome(String(args.out || 'baseline.json')));
const baseline = { generatedAt: new Date().toISOString(), node: process.version, roots: roots.map(measure), totalSkillMdCount: 0, totalBytes: 0, totalFrontMatterBytes: 0 };
for (const item of baseline.roots) {
  baseline.totalSkillMdCount += item.skillMdCount;
  baseline.totalBytes += item.totalBytes;
  baseline.totalFrontMatterBytes += item.frontMatterBytes;
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ output, ...baseline }, null, 2)}\n`);
