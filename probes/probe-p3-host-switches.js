#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const KEYS = ['skills.enabled', 'scanPaths', 'skillRoots', 'skill roots', 'ignore'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'cache', 'Cache', 'GPUCache']);

function rootsFromArgs() {
  const args = process.argv.slice(2);
  const roots = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root' && args[i + 1]) roots.push(normalizeRoot(args[++i]));
  }
  if (roots.length) return roots;
  return [
    'C:\\Program Files\\ZCode\\resources\\app.asar.unpacked',
    'C:\\Program Files\\ZCode\\resources\\app',
    'C:\\Program Files\\ZCode\\resources\\app.asar.unpacked\\resources',
    '/c/Program Files/ZCode/resources/app.asar.unpacked',
    path.join('C:', 'Program Files', 'ZCode', 'resources', 'app.asar.unpacked')
  ].map(normalizeRoot).filter((value, index, values) => values.indexOf(value) === index);
}

function normalizeRoot(value) {
  const posixDrive = String(value).match(/^\/([a-zA-Z])\/(.*)$/);
  if (posixDrive) return path.resolve(`${posixDrive[1].toUpperCase()}:\\${posixDrive[2].replace(/\//g, path.sep)}`);
  return path.resolve(value);
}

function walk(root, result = [], warnings = []) {
  try {
    if (!fs.existsSync(root)) return result;
    const stat = fs.statSync(root);
    if (stat.isFile()) return [root];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const current = path.join(root, entry.name);
      if (entry.isDirectory()) walk(current, result, warnings);
      else if (entry.isFile() && !/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|otf|dll|exe|node|zip|7z|asar)$/i.test(entry.name)) result.push(current);
    }
  } catch (error) {
    warnings.push({ root, message: error.message });
  }
  return result;
}

function scan(file, warnings = []) {
  let stat;
  let text;
  try {
    stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    warnings.push({ file, message: error.message });
    return [];
  }
  const found = [];
  for (const key of KEYS) {
    const expression = new RegExp(`.{0,100}${escapeRegExp(key)}.{0,160}`, 'ig');
    for (const match of text.matchAll(expression)) {
      const before = text.slice(0, match.index);
      found.push({ key, offset: match.index, line: before.split('\n').length, context: match[0] });
    }
  }
  return found;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const discoveries = [];
const warnings = [];
for (const root of rootsFromArgs()) {
  for (const file of walk(root, [], warnings)) {
    for (const match of scan(file, warnings)) discoveries.push({ root, file, ...match });
  }
}
process.stdout.write(`${JSON.stringify({ probe: 'P3', keys: KEYS, roots: rootsFromArgs(), discoveries, warnings }, null, 2)}\n`);
