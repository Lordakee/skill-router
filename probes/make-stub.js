#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontMatter, normalizeText, expandHome, within } = require('../lib/router-core.js');

function yamlQuote(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

function stubFromContent(content, fallbackId, options = {}) {
  const frontMatter = parseFrontMatter(normalizeText(content));
  const id = String((options.forceId ? (fallbackId || frontMatter.name) : (frontMatter.name || fallbackId)) || 'unnamed-skill').trim();
  let description = String(frontMatter.description || '').replace(/\s+/g, ' ').trim();
  if (description.length > 100) description = `${description.slice(0, 97)}...`;
  return `---\nname: ${id}\ndescription: ${yamlQuote(description || `${id} (stub)`)}\n---\nFull skill available via skill-router. Call skill_load('${id}'), then follow returned instructions.\n`;
}

function findSkillFiles(source) {
  const stat = fs.statSync(source);
  if (stat.isFile()) return [source];
  const result = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name === 'SKILL.md') result.push(target);
    }
  };
  walk(source);
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function generateStubs(source, out, options = {}) {
  const sourceAbsolute = path.resolve(source);
  const outAbsolute = path.resolve(out);
  if (within(sourceAbsolute, outAbsolute) || within(outAbsolute, sourceAbsolute)) throw new Error('Stub output must be separate from source');
  fs.mkdirSync(out, { recursive: true });
  const sourceIsFile = fs.statSync(source).isFile();
  const sourceRoot = sourceIsFile ? path.dirname(path.dirname(source)) : source;
  const generated = [];
  for (const file of findSkillFiles(source)) {
    const rel = sourceIsFile ? path.join(path.basename(path.dirname(file)), 'SKILL.md') : path.relative(sourceRoot, file);
    const target = path.join(out, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = stubFromContent(fs.readFileSync(file, 'utf8'), options.id || path.basename(path.dirname(file)));
    fs.writeFileSync(target, content, 'utf8');
    generated.push({ source: file, output: target, bytes: Buffer.byteLength(content), id: parseFrontMatter(content).name });
  }
  return generated;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.out) {
    process.stderr.write('Usage: node make-stub.js --source <skill-root-or-SKILL.md> --out <directory>\n');
    process.exit(2);
  }
  try { process.stdout.write(`${JSON.stringify({ generated: generateStubs(path.resolve(expandHome(String(args.source))), path.resolve(expandHome(String(args.out))), { id: args.id }) }, null, 2)}\n`); }
  catch (error) { process.stderr.write(`make-stub failed: ${error.message}\n`); process.exit(1); }
}

module.exports = { stubFromContent, generateStubs, parseArgs };
