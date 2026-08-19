#!/usr/bin/env node
/**
 * Remove skill-router MCP registrations, optionally restore roots and purge the vault.
 *
 * Usage:
 *   node uninstall.mjs --snapshot <dir> [--roots a,b] [--vault path] [--purge-vault]
 *   node uninstall.mjs --mcp-only [--server-id id] [--vault path]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { expandHome, isSafeRelative, within } = require('./lib/router-core.js');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    parsed[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const DRY = Boolean(args['dry-run']);
let HOME_DIR;
let HERE;
let ROLLBACK;
let requestedVault;
let VAULT;
let RECEIPT_PATH;
let receipt;
let SERVER_ID;

function userPath(value) {
  return path.resolve(expandHome(String(value), HOME_DIR));
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function existingPathLinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const links = [];
  let current = parsed.root;
  for (const part of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) links.push(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return links;
}

function assertPathHasNoLinks(target, label) {
  const links = existingPathLinks(target);
  if (links.length) throw new Error(`${label} uses a symlink or junction alias: ${links.join(', ')}`);
}

function canonicalTarget(target, label) {
  const resolved = path.resolve(target);
  assertPathHasNoLinks(resolved, label);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`${label} has no accessible ancestor`);
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), path.relative(existing, resolved));
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable or invalid JSON: ${error.message}`); }
}

function textDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function rollbackArguments(dryRun) {
  const values = ['--snapshot', userPath(args.snapshot), '--home', HOME_DIR];
  if (Object.prototype.hasOwnProperty.call(args, 'roots')) values.push('--roots', String(args.roots));
  if (dryRun) values.push('--dry-run');
  return values;
}

function invokeRollback(dryRun) {
  const result = spawnSync(process.execPath, [ROLLBACK, ...rollbackArguments(dryRun)], {
    cwd: HERE,
    encoding: 'utf8',
    env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`Rollback ${dryRun ? 'preflight' : 'restore'} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  if (result.stderr) process.stderr.write(result.stderr);
}

function validateReceiptForPurge() {
  if (!receipt || receipt.schemaVersion !== 1 || !path.isAbsolute(receipt.vault) || !Array.isArray(receipt.roots) || receipt.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('--purge-vault requires a valid install-receipt.json in the requested vault');
  }
  assertPathHasNoLinks(requestedVault, 'Purge vault');
  if (!samePath(VAULT, receipt.vault)) throw new Error('Requested vault does not resolve to the canonical path in its receipt');
  if (!fs.existsSync(VAULT) || fs.lstatSync(VAULT).isSymbolicLink() || !fs.lstatSync(VAULT).isDirectory()) throw new Error('Receipt vault is not a regular directory');
  if (!samePath(fs.realpathSync.native(VAULT), receipt.vault)) throw new Error('Current vault realpath no longer matches its receipt');
  if (fs.lstatSync(RECEIPT_PATH).isSymbolicLink()) throw new Error('Install receipt may not be a symlink');
  const filesystemRoot = path.parse(VAULT).root;
  if (within(VAULT, HOME_DIR) || samePath(VAULT, filesystemRoot)) throw new Error('Protected home, an ancestor of home, or filesystem root cannot be purged');
  if (within(VAULT, HERE) || within(HERE, VAULT)) throw new Error('The skill-router workspace and any overlapping vault are protected from purge');
  for (const root of receipt.roots) {
    if (within(VAULT, root) || within(root, VAULT)) throw new Error(`Receipt vault overlaps a recorded scan root: ${root}`);
  }
  return receipt;
}

function rootsContainStubs(record) {
  const candidates = [];
  if (Array.isArray(record.managedStubs)) {
    for (const item of record.managedStubs) {
      if (!item || !path.isAbsolute(item.sourceRoot) || !isSafeRelative(item.path)) throw new Error('Install receipt contains an invalid managed stub target');
      const target = path.resolve(item.sourceRoot, item.path);
      if (!within(item.sourceRoot, target)) throw new Error('Install receipt contains a stub target outside its root');
      candidates.push(target);
    }
  }
  if (!candidates.length) {
    for (const root of record.roots) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        candidates.push(path.join(root, entry.name, 'SKILL.md'));
      }
    }
  }
  return candidates.some(file => {
    assertPathHasNoLinks(file, 'Recorded stub target');
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return false;
    return /skill_load\(\s*['"][^'"]+['"]\s*\)/.test(fs.readFileSync(file, 'utf8'));
  });
}

function removeManagedCodexBlock(raw, fingerprint) {
  const prefix = `# skill-router:begin ${SERVER_ID} `;
  const starts = [];
  if (raw.startsWith(prefix)) starts.push(0);
  let cursor = raw.indexOf(`\n${prefix}`);
  while (cursor >= 0) {
    starts.push(cursor + 1);
    cursor = raw.indexOf(`\n${prefix}`, cursor + prefix.length + 1);
  }
  if (starts.length > 1) throw new Error(`Multiple managed Codex blocks found for ${SERVER_ID}`);
  if (starts.length === 1) {
    const start = starts[0];
    const lineEnd = raw.indexOf('\n', start);
    const beginLine = raw.slice(start, lineEnd < 0 ? raw.length : lineEnd).replace(/\r$/, '');
    const blockFingerprint = beginLine.slice(prefix.length).trim();
    if (!/^[a-f0-9]{32}$/.test(blockFingerprint)) throw new Error(`Managed Codex block has an invalid fingerprint for ${SERVER_ID}`);
    if (fingerprint && blockFingerprint !== fingerprint) {
      return { next: raw, warning: `codex: ownership fingerprint mismatch; manual confirmation required for ${SERVER_ID}` };
    }
    const endMarker = `# skill-router:end ${SERVER_ID} ${blockFingerprint}`;
    const endToken = `\n${endMarker}`;
    const endTokenStart = raw.indexOf(endToken, lineEnd < 0 ? start : lineEnd);
    const endStart = endTokenStart < 0 ? -1 : endTokenStart + 1;
    if (endStart < 0) throw new Error(`Managed Codex block is missing its end marker for ${SERVER_ID}`);
    let end = endStart + endMarker.length;
    if (raw.slice(end, end + 2) === '\r\n') end += 2;
    else if (raw[end] === '\n') end += 1;
    let begin = start;
    if (begin > 1 && raw.slice(begin - 2, begin) === '\r\n') begin -= 2;
    else if (begin > 0 && raw[begin - 1] === '\n') begin -= 1;
    return { next: raw.slice(0, begin) + raw.slice(end), warning: null };
  }

  const marker = `[mcp_servers.${SERVER_ID}]`;
  const markerTokenIndex = raw.indexOf(`\n${marker}`);
  const markerIndex = raw.startsWith(marker) ? 0 : markerTokenIndex < 0 ? -1 : markerTokenIndex + 1;
  if (markerIndex < 0) return { next: raw, warning: null };
  const nextSection = raw.indexOf('\n[', markerIndex + marker.length);
  const end = nextSection < 0 ? raw.length : nextSection + 1;
  const legacySection = raw.slice(markerIndex, end);
  const normalizedSection = `${legacySection.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
  const receiptSectionHash = receipt?.serverId === SERVER_ID ? receipt.codexSectionHash : null;
  const ownedByReceiptHash = typeof receiptSectionHash === 'string' && textDigest(normalizedSection) === receiptSectionHash;
  if (ownedByReceiptHash || (fingerprint && legacySection.includes(`SKILL_ROUTER_INSTALL_FINGERPRINT = "${fingerprint}"`))) {
    let begin = markerIndex;
    if (begin > 1 && raw.slice(begin - 2, begin) === '\r\n') begin -= 2;
    else if (begin > 0 && raw[begin - 1] === '\n') begin -= 1;
    return { next: raw.slice(0, begin) + raw.slice(end), warning: null };
  }
  return { next: raw, warning: `codex: unmanaged legacy section ${marker} found; manual confirmation required` };
}

function buildConfigPlans() {
  const fingerprint = receipt?.serverId === SERVER_ID && typeof receipt.mcpFingerprint === 'string' ? receipt.mcpFingerprint : null;
  const definitions = [
    {
      name: 'zcode', config: path.join(HOME_DIR, '.zcode', 'cli', 'config.json'),
      next(raw) { const value = JSON.parse(raw); if (!value.mcp?.servers?.[SERVER_ID]) return raw; delete value.mcp.servers[SERVER_ID]; return `${JSON.stringify(value, null, 2)}\n`; },
    },
    {
      name: 'claude', config: path.join(HOME_DIR, '.claude.json'),
      next(raw) { const value = JSON.parse(raw); if (!value.mcpServers?.[SERVER_ID]) return raw; delete value.mcpServers[SERVER_ID]; return `${JSON.stringify(value, null, 2)}\n`; },
    },
    {
      name: 'opencode', config: path.join(HOME_DIR, '.config', 'opencode', 'opencode.json'),
      next(raw) { const value = JSON.parse(raw); if (!value.mcp?.[SERVER_ID]) return raw; delete value.mcp[SERVER_ID]; return `${JSON.stringify(value, null, 2)}\n`; },
    },
  ];

  const plans = [];
  for (const definition of definitions) {
    if (!fs.existsSync(definition.config)) { console.log(`[mcp] ${definition.name}: config not found, skipped`); continue; }
    const raw = fs.readFileSync(definition.config, 'utf8');
    const next = definition.next(raw);
    if (next === raw) { console.log(`[mcp] ${definition.name}: not registered, skipped`); continue; }
    plans.push({ name: definition.name, config: definition.config, raw, next });
  }

  const codexConfig = path.join(HOME_DIR, '.codex', 'config.toml');
  if (!fs.existsSync(codexConfig)) console.log('[mcp] codex: config not found, skipped');
  else {
    const raw = fs.readFileSync(codexConfig, 'utf8');
    const result = removeManagedCodexBlock(raw, fingerprint);
    if (result.warning) console.log(`[mcp] ${result.warning}`);
    if (result.next === raw) console.log('[mcp] codex: no owned managed block removed');
    else plans.push({ name: 'codex', config: codexConfig, raw, next: result.next });
  }
  return plans;
}

function applyConfigPlans(plans) {
  for (const plan of plans) {
    if (DRY) { console.log(`[mcp] ${plan.name}: would deregister (backup kept)`); continue; }
    if (fs.readFileSync(plan.config, 'utf8') !== plan.raw) throw new Error(`${plan.name} config changed after deregistration preflight`);
    const backup = `${plan.config}.bak-sr-uninstall-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    fs.copyFileSync(plan.config, backup);
    fs.writeFileSync(plan.config, plan.next, 'utf8');
    console.log(`[mcp] ${plan.name}: deregistered (backup: ${path.basename(backup)})`);
  }
}

function main() {
  const requestedHome = args.home ? path.resolve(expandHome(String(args.home))) : os.homedir();
  if (!fs.existsSync(requestedHome) || !fs.lstatSync(requestedHome).isDirectory()) throw new Error(`Home directory not found: ${requestedHome}`);
  HOME_DIR = fs.realpathSync.native(requestedHome);
  HERE = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
  ROLLBACK = path.join(HERE, 'rollback.mjs');
  requestedVault = args.vault ? userPath(args.vault) : path.join(HOME_DIR, '.zcode', 'skill-store');
  VAULT = canonicalTarget(requestedVault, 'Vault path');
  RECEIPT_PATH = path.join(VAULT, 'install-receipt.json');
  receipt = fs.existsSync(RECEIPT_PATH) ? readJson(RECEIPT_PATH, 'Install receipt') : null;
  SERVER_ID = String(args['server-id'] || receipt?.serverId || 'skill-router');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(SERVER_ID)) throw new Error('Server id must contain only letters, digits, underscore, or hyphen');
  if (args.snapshot && args['mcp-only']) throw new Error('--snapshot and --mcp-only are mutually exclusive');
  if (!args.snapshot && !args['mcp-only']) throw new Error('Provide --snapshot <dir> to restore roots, or --mcp-only to strip registrations only');

  if (args.snapshot) {
    console.log(`[1/3] validating scan-root restore from ${userPath(args.snapshot)}`);
    invokeRollback(true);
  } else {
    console.log('[1/3] --mcp-only: roots will remain unchanged');
  }

  let purgeReceipt = null;
  if (args['purge-vault']) {
    purgeReceipt = validateReceiptForPurge();
    if (args['mcp-only'] && rootsContainStubs(purgeReceipt)) throw new Error('Refusing --mcp-only --purge-vault while recorded scan roots still contain stubs');
  }

  const configPlans = buildConfigPlans();
  if (DRY) {
    console.log('[2/3] MCP deregistration plan validated (dry-run)');
    applyConfigPlans(configPlans);
    console.log(args['purge-vault'] ? `[3/3] would purge receipt-matched vault ${VAULT}` : `[3/3] vault would be kept at ${VAULT}`);
    console.log('Dry run complete; no files were changed.');
    return;
  }

  if (args.snapshot) {
    console.log('[1/3] restoring scan roots');
    invokeRollback(false);
  }
  console.log(`[2/3] deregistering MCP server ${SERVER_ID}`);
  applyConfigPlans(configPlans);
  if (args['purge-vault']) {
    if (!purgeReceipt) throw new Error('Internal purge plan error');
    validateReceiptForPurge();
    console.log(`[3/3] purging receipt-matched vault ${VAULT}`);
    fs.rmSync(VAULT, { recursive: true, force: true });
  } else {
    console.log(`[3/3] vault kept at ${VAULT} (use --purge-vault to delete it safely)`);
  }
  console.log('\nUninstall complete. Restart agent sessions to return to native skill loading.');
}

try { main(); }
catch (error) {
  console.error(`ABORT: ${error.message}`);
  process.exitCode = 2;
}
