#!/usr/bin/env node
/**
 * Install skill-router into an explicit set of agent skill roots.
 *
 * Usage:
 *   node setup.mjs [--home path] [--roots pathA,pathB] [--vault path]
 *                  [--agents zcode,codex,claude,opencode]
 *                  [--server-id skill-router] [--dry-run] [--skip-mcp]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { generateManifest } = require('./lib/generate-manifest.js');
const { expandHome, hashBuffer, isSafeRelative, within } = require('./lib/router-core.js');
const { migrate } = require('./migrate/migrate-canary.js');
const { regenerate } = require('./migrate/regenerate-for-vault.js');
const { stubFromContent } = require('./probes/make-stub.js');

const TOOL_VERSION = '2.1.0';
const RECEIPT_NAME = 'install-receipt.json';
const SERVER_REL = path.join('mcp', 'server.js');

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
let SERVER_ABS;
let SERVER_ID;
let ROOTS;
let VAULT;
let WORKSPACE;
let AGENTS;

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

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

function samePathSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(pathKey));
  return right.every(item => expected.has(pathKey(item)));
}

function existingPathLinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const links = [];
  let current = parsed.root;
  const relative = path.relative(parsed.root, resolved);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) links.push(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return links;
}

function assertPathHasNoLinks(target, label) {
  const links = existingPathLinks(target);
  if (links.length) throw new Error(`${label} uses a symlink or junction: ${links.join(', ')}`);
}

function canonicalTarget(target, label) {
  const resolved = path.resolve(target);
  assertPathHasNoLinks(resolved, label);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`${label} has no accessible ancestor: ${resolved}`);
    existing = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(existing);
  return path.resolve(canonicalAncestor, path.relative(existing, resolved));
}

function buildRootPlan() {
  const explicit = Object.prototype.hasOwnProperty.call(args, 'roots');
  const rawRoots = explicit
    ? String(args.roots).split(',').map(value => value.trim()).filter(Boolean)
    : [path.join(HOME_DIR, '.zcode', 'skills'), path.join(HOME_DIR, '.agents', 'skills')].filter(root => fs.existsSync(root));
  if (!rawRoots.length) throw new Error('No skill roots were provided or found; pass --roots with at least one directory');

  const roots = [];
  const seen = new Set();
  const problems = [];
  for (const raw of rawRoots) {
    const resolved = userPath(raw);
    const links = existingPathLinks(resolved);
    if (links.length) {
      problems.push(`${resolved} (symlink/junction ancestor: ${links.join(', ')})`);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(resolved); }
    catch { problems.push(`${resolved} (not found)`); continue; }
    if (stat.isSymbolicLink()) { problems.push(`${resolved} (symlink/junction root)`); continue; }
    if (!stat.isDirectory()) { problems.push(`${resolved} (not a directory)`); continue; }
    const canonical = fs.realpathSync.native(resolved);
    const key = pathKey(canonical);
    if (!seen.has(key)) { seen.add(key); roots.push(canonical); }
  }
  if (problems.length) throw new Error(`Invalid skill roots:\n- ${problems.join('\n- ')}`);
  if (!roots.length) throw new Error('No unique existing skill root remains after canonicalization');
  return roots;
}

function assertVaultLocation() {
  const filesystemRoot = path.parse(VAULT).root;
  if (within(VAULT, HOME_DIR) || samePath(VAULT, filesystemRoot)) throw new Error('Vault may not be the home, an ancestor of home, or the filesystem root');
  if (within(VAULT, WORKSPACE) || within(WORKSPACE, VAULT)) throw new Error('Vault may not overlap the skill-router workspace');
  for (const root of ROOTS) {
    if (within(VAULT, root) || within(root, VAULT)) throw new Error(`Vault may not overlap a skill root: ${root}`);
  }
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is unreadable or invalid JSON: ${error.message}`); }
}

function validateReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== 1 || !path.isAbsolute(receipt.vault) || !Array.isArray(receipt.roots) || receipt.roots.some(root => !path.isAbsolute(root)) || typeof receipt.serverId !== 'string') {
    throw new Error('Existing install receipt is invalid');
  }
  if (receipt.serverId !== SERVER_ID) throw new Error(`Existing install receipt uses server id ${receipt.serverId}, not ${SERVER_ID}`);
  const actualVault = fs.realpathSync.native(VAULT);
  if (!samePath(receipt.vault, VAULT) || !samePath(actualVault, receipt.vault)) throw new Error('Existing install receipt does not match the canonical vault path');
  if (!samePathSet(receipt.roots, ROOTS)) throw new Error('Existing install receipt roots do not match the requested roots');
  return receipt;
}

function receiptStubTargets(receipt) {
  if (!Array.isArray(receipt.managedStubs) || !receipt.managedStubs.length) return [];
  return receipt.managedStubs.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || !path.isAbsolute(item.sourceRoot) || !isSafeRelative(item.path)) {
      throw new Error('Existing install receipt contains an invalid managed stub target');
    }
    const matchingRoot = ROOTS.find(root => samePath(root, item.sourceRoot));
    if (!matchingRoot) throw new Error(`Receipt stub target uses an unrequested root: ${item.id}`);
    const target = path.resolve(matchingRoot, item.path);
    if (!within(matchingRoot, target)) throw new Error(`Receipt stub target escapes its root: ${item.id}`);
    assertPathHasNoLinks(target, `Receipt stub target for ${item.id}`);
    return { id: item.id, sourceRoot: matchingRoot, path: item.path, target };
  });
}

function isStubText(text) {
  return /skill_load\(\s*['"][^'"]+['"]\s*\)/.test(text);
}

function scanTopLevelSkillFiles() {
  const files = [];
  for (const root of ROOTS) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      if (fs.existsSync(file) && fs.lstatSync(file).isFile()) files.push(file);
    }
  }
  return files;
}

function detectExistingInstallation() {
  const receiptPath = path.join(VAULT, RECEIPT_NAME);
  const manifestPath = path.join(VAULT, '.router', 'vault-manifest.json');
  const hasReceipt = fs.existsSync(receiptPath);
  const hasManifest = fs.existsSync(manifestPath);
  if (!hasReceipt && !hasManifest) {
    if (fs.existsSync(VAULT)) throw new Error(`Vault path already exists without a managed receipt or manifest: ${VAULT}`);
    return { mode: 'new', receipt: null, receiptPath, manifestPath };
  }

  const receipt = hasReceipt ? validateReceipt(readJson(receiptPath, 'Install receipt')) : null;
  const managed = receipt ? receiptStubTargets(receipt) : [];
  const candidates = managed.length ? managed.map(item => item.target) : scanTopLevelSkillFiles();
  if (!candidates.length) throw new Error('Existing installation was detected, but no scan-root SKILL.md files can prove its state');
  const states = candidates.map(file => {
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return 'missing';
    return isStubText(fs.readFileSync(file, 'utf8')) ? 'stub' : 'full';
  });
  if (states.every(state => state === 'stub')) return { mode: 'idempotent', receipt, receiptPath, manifestPath };
  if (receipt && states.every(state => state === 'full')) return { mode: 'repair', receipt, receiptPath, manifestPath };
  throw new Error('Existing installation is in a mixed or unverifiable root state; restore or uninstall it before reinstalling');
}

function validateLiveManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.skills) || !manifest.skills.length) throw new Error('No skills were discovered in the requested roots');
  const ids = new Set();
  for (const skill of manifest.skills) {
    if (!skill || typeof skill.id !== 'string' || !skill.id || skill.id.includes('/') || skill.id.includes('\\')) throw new Error('Manifest contains an invalid skill id');
    if (ids.has(skill.id)) throw new Error(`Duplicate skill id is unsupported across namespaces: ${skill.id}`);
    ids.add(skill.id);
  }
}

function buildStubPlan(manifest) {
  return manifest.skills.map(skill => {
    const sourceRoot = ROOTS.find(root => samePath(root, skill.source_root));
    if (!sourceRoot || !isSafeRelative(skill.path)) throw new Error(`Manifest target is outside the requested roots: ${skill.id}`);
    const target = path.resolve(sourceRoot, skill.path);
    if (!within(sourceRoot, target)) throw new Error(`Manifest target escapes its root: ${skill.id}`);
    assertPathHasNoLinks(target, `Stub target for ${skill.id}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Stub target may not be a symlink or junction: ${target}`);
    if (!stat.isFile()) throw new Error(`Stub target is not a regular file: ${target}`);
    const content = fs.readFileSync(target);
    if (hashBuffer(content) !== skill.content_hash) throw new Error(`Source changed while planning stub replacement: ${skill.id}`);
    return { id: skill.id, sourceRoot, path: skill.path, target, content };
  });
}

function verifyRepair(existing, live, stubs) {
  if (!existing.receipt || !fs.existsSync(existing.manifestPath)) throw new Error('Reinstall requires both an install receipt and vault manifest');
  const recordedTargets = receiptStubTargets(existing.receipt).map(item => `${pathKey(item.sourceRoot)}\0${item.path}`).sort();
  const currentTargets = stubs.map(item => `${pathKey(item.sourceRoot)}\0${item.path}`).sort();
  if (recordedTargets.length !== currentTargets.length || recordedTargets.some((item, index) => item !== currentTargets[index])) {
    throw new Error('Restored roots no longer match the installation receipt; uninstall and perform a fresh install');
  }
  const vaultManifest = readJson(existing.manifestPath, 'Vault manifest');
  if (!Array.isArray(vaultManifest.skills) || vaultManifest.skills.length !== live.skills.length) throw new Error('Vault manifest no longer matches restored roots');
  const byId = new Map(vaultManifest.skills.map(skill => [skill.id, skill]));
  for (const source of live.skills) {
    const stored = byId.get(source.id);
    if (!stored || stored.content_hash !== source.content_hash || !samePath(stored.source_root, VAULT) || !isSafeRelative(stored.path)) {
      throw new Error(`Vault content no longer matches restored skill: ${source.id}`);
    }
    const storedFile = path.resolve(VAULT, stored.path);
    assertPathHasNoLinks(storedFile, `Vault file for restored skill ${source.id}`);
    if (!within(VAULT, storedFile) || !fs.existsSync(storedFile) || fs.lstatSync(storedFile).isSymbolicLink() || hashBuffer(fs.readFileSync(storedFile)) !== stored.content_hash) {
      throw new Error(`Vault content failed verification for restored skill: ${source.id}`);
    }
  }
}

function detectTar() {
  let output;
  try { output = execFileSync('tar', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`Unable to execute tar --version: ${error.message}`); }
  const version = String(output).trim().split(/\r?\n/)[0];
  let implementation;
  if (/bsdtar|libarchive/i.test(output)) implementation = 'bsdtar';
  else if (/GNU tar/i.test(output)) implementation = 'gnu-tar';
  else throw new Error(`Unsupported tar implementation: ${version || 'unknown'}`);
  return {
    implementation,
    version,
    pathMode: process.platform === 'win32' && implementation === 'gnu-tar' ? 'msys' : 'native',
  };
}

function tarPath(value, tar) {
  if (process.platform !== 'win32' || tar.pathMode !== 'msys') return value;
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):\/?/, (match, drive) => `/${drive.toLowerCase()}/`);
}

function archiveMembers(archive, tar) {
  let listing;
  try { listing = execFileSync('tar', ['-tzf', tarPath(archive, tar)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`Snapshot archive cannot be listed: ${path.basename(archive)} (${error.message})`); }
  const members = listing.split(/\r?\n/).filter(Boolean);
  if (!members.length) throw new Error(`Snapshot archive is empty: ${path.basename(archive)}`);
  let rootDeclared = false;
  for (const raw of members) {
    const member = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    if (member.startsWith('/') || /^[A-Za-z]:\//.test(member) || member.startsWith('//')) throw new Error(`Snapshot archive has an absolute member: ${path.basename(archive)}`);
    const parts = member.split('/').filter(Boolean);
    if (parts.some(part => part === '..')) throw new Error(`Snapshot archive has a parent traversal member: ${path.basename(archive)}`);
    if (parts[0] !== 'skills') throw new Error(`Snapshot archive member is not rooted at skills/: ${path.basename(archive)}`);
    if (parts.length === 1) rootDeclared = true;
  }
  if (!rootDeclared) throw new Error(`Snapshot archive does not declare its skills/ root: ${path.basename(archive)}`);
  return members;
}

function createArchive(root, archive, tar) {
  let archiveParent = path.dirname(root);
  let archiveMember = path.basename(root);
  let view = null;
  try {
    if (archiveMember !== 'skills' && tar.implementation === 'bsdtar') {
      view = exclusiveDirectory(path.dirname(archive), '.archive-view-');
      fs.cpSync(root, path.join(view, 'skills'), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      archiveParent = view;
      archiveMember = 'skills';
    }
    const arguments_ = ['-czf', tarPath(archive, tar), '-C', tarPath(archiveParent, tar)];
    if (archiveMember !== 'skills') arguments_.push('--transform=s,^[^/]*,skills,');
    arguments_.push(archiveMember);
    execFileSync('tar', arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    archiveMembers(archive, tar);
  } finally {
    if (view && fs.existsSync(view)) fs.rmSync(view, { recursive: true, force: true });
  }
}

function exclusiveDirectory(parent, prefix) {
  fs.mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(parent, `${prefix}${crypto.randomBytes(6).toString('hex')}`);
    try { fs.mkdirSync(candidate); return candidate; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error(`Unable to allocate an exclusive directory under ${parent}`);
}

function snapshotStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createSnapshot(tar) {
  const parent = canonicalTarget(path.join(HOME_DIR, 'skill-router-backups'), 'Snapshot parent');
  assertPathHasNoLinks(parent, 'Snapshot parent');
  const snapshot = exclusiveDirectory(parent, `snapshot-${snapshotStamp()}-`);
  try {
    const records = ROOTS.map((root, index) => {
      const archive = `root-${index + 1}.tar.gz`;
      createArchive(root, path.join(snapshot, archive), tar);
      log('1/5', `snapshot ${archive} <- ${root}`);
      return { root, archive };
    });
    fs.writeFileSync(path.join(snapshot, 'snapshot.json'), `${JSON.stringify({
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      roots: records,
    }, null, 2)}\n`, 'utf8');
    return snapshot;
  } catch (error) {
    fs.rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value).replace(/\\/g, '/'));
}

function codexSection(manifestPath, fingerprint) {
  return [
    `[mcp_servers.${SERVER_ID}]`,
    'command = "node"',
    `args = [${tomlString(SERVER_ABS)}]`,
    `env = { SKILL_ROUTER_MANIFEST = ${tomlString(manifestPath)}, SKILL_ROUTER_INSTALL_FINGERPRINT = "${fingerprint}" }`,
    'startup_timeout_sec = 30.0',
    '',
  ].join('\n');
}

function codexBlock(manifestPath, fingerprint) {
  const begin = `# skill-router:begin ${SERVER_ID} ${fingerprint}`;
  const end = `# skill-router:end ${SERVER_ID} ${fingerprint}`;
  return `${begin}\n${codexSection(manifestPath, fingerprint)}${end}\n`;
}

function jsonRegistrationFingerprint(registration, agent) {
  if (agent === 'zcode' || agent === 'claude') return registration?.env?.SKILL_ROUTER_INSTALL_FINGERPRINT;
  if (agent === 'opencode') return registration?.environment?.SKILL_ROUTER_INSTALL_FINGERPRINT;
  return undefined;
}

function buildAgents() {
  return {
    zcode: {
      config: path.join(HOME_DIR, '.zcode', 'cli', 'config.json'),
      next(raw, manifestPath, fingerprint) {
        const config = JSON.parse(raw);
        config.mcp = config.mcp || {};
        config.mcp.servers = config.mcp.servers || {};
        const current = config.mcp.servers[SERVER_ID];
        if (current) {
          if (jsonRegistrationFingerprint(current, 'zcode') === fingerprint) return null;
          throw new Error(`zcode already has an unmanaged MCP registration named ${SERVER_ID}`);
        }
        config.mcp.servers[SERVER_ID] = {
          type: 'stdio', command: 'node', args: [SERVER_ABS], enabled: true, timeoutMs: 120000,
          env: { SKILL_ROUTER_MANIFEST: manifestPath, SKILL_ROUTER_INSTALL_FINGERPRINT: fingerprint },
        };
        return `${JSON.stringify(config, null, 2)}\n`;
      },
    },
    codex: {
      config: path.join(HOME_DIR, '.codex', 'config.toml'),
      next(raw, manifestPath, fingerprint) {
        const begin = `# skill-router:begin ${SERVER_ID} ${fingerprint}`;
        if (raw.includes(begin)) return null;
        if (raw.includes(`# skill-router:begin ${SERVER_ID} `) || raw.includes(`[mcp_servers.${SERVER_ID}]`)) {
          throw new Error(`codex already has an unmanaged or differently owned MCP registration named ${SERVER_ID}`);
        }
        const separator = raw.length === 0 || raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
        return `${raw}${separator}${codexBlock(manifestPath, fingerprint)}`;
      },
    },
    claude: {
      config: path.join(HOME_DIR, '.claude.json'),
      next(raw, manifestPath, fingerprint) {
        const config = JSON.parse(raw);
        config.mcpServers = config.mcpServers || {};
        const current = config.mcpServers[SERVER_ID];
        if (current) {
          if (jsonRegistrationFingerprint(current, 'claude') === fingerprint) return null;
          throw new Error(`claude already has an unmanaged MCP registration named ${SERVER_ID}`);
        }
        config.mcpServers[SERVER_ID] = {
          type: 'stdio', command: 'node', args: [SERVER_ABS],
          env: { SKILL_ROUTER_MANIFEST: manifestPath, SKILL_ROUTER_INSTALL_FINGERPRINT: fingerprint },
        };
        return `${JSON.stringify(config, null, 2)}\n`;
      },
    },
    opencode: {
      config: path.join(HOME_DIR, '.config', 'opencode', 'opencode.json'),
      next(raw, manifestPath, fingerprint) {
        const config = JSON.parse(raw);
        config.mcp = config.mcp || {};
        const current = config.mcp[SERVER_ID];
        if (current) {
          if (jsonRegistrationFingerprint(current, 'opencode') === fingerprint) return null;
          throw new Error(`opencode already has an unmanaged MCP registration named ${SERVER_ID}`);
        }
        config.mcp[SERVER_ID] = {
          enabled: true, type: 'local', command: ['node', SERVER_ABS],
          environment: { SKILL_ROUTER_MANIFEST: manifestPath, SKILL_ROUTER_INSTALL_FINGERPRINT: fingerprint },
        };
        return `${JSON.stringify(config, null, 2)}\n`;
      },
    },
  };
}

function planAgentRegistrations(manifestPath, fingerprint) {
  if (args['skip-mcp']) {
    log('5/5', '--skip-mcp set: MCP registration bypassed');
    return [];
  }
  const wanted = args.agents
    ? String(args.agents).split(',').map(value => value.trim()).filter(Boolean)
    : Object.keys(AGENTS);
  const plans = [];
  for (const name of [...new Set(wanted)]) {
    const agent = AGENTS[name];
    if (!agent) { log('5/5', `unknown agent "${name}" (expected zcode|codex|claude|opencode)`); continue; }
    if (!fs.existsSync(agent.config)) { log('5/5', `${name}: config not found, skipped`); continue; }
    const raw = fs.readFileSync(agent.config, 'utf8');
    const next = agent.next(raw, manifestPath, fingerprint);
    if (next === null) { log('5/5', `${name}: already registered`); continue; }
    plans.push({ name, config: agent.config, raw, next });
  }
  return plans;
}

function applyAgentRegistrations(plans, backupTag) {
  for (const plan of plans) {
    if (DRY) { log('5/5', `${plan.name}: would register`); continue; }
    if (fs.readFileSync(plan.config, 'utf8') !== plan.raw) throw new Error(`${plan.name} config changed after registration preflight`);
    const backup = `${plan.config}.bak-skillrouter-${backupTag}`;
    fs.copyFileSync(plan.config, backup);
    fs.writeFileSync(plan.config, plan.next, 'utf8');
    log('5/5', `${plan.name}: registered (backup: ${path.basename(backup)})`);
  }
}

function validateStagedVault(stage, finalVault, live) {
  const manifestPath = path.join(stage, '.router', 'vault-manifest.json');
  const manifest = readJson(manifestPath, 'Staged vault manifest');
  if (!Array.isArray(manifest.skills) || manifest.skills.length !== live.skills.length) throw new Error('Staged vault manifest has an unexpected skill count');
  const liveById = new Map(live.skills.map(skill => [skill.id, skill]));
  for (const skill of manifest.skills) {
    const source = liveById.get(skill.id);
    if (!source || !samePath(skill.source_root, finalVault) || !isSafeRelative(skill.path)) throw new Error(`Staged vault manifest entry is invalid: ${skill.id}`);
    const file = path.resolve(stage, skill.path);
    if (!within(stage, file) || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Staged vault file is invalid: ${skill.id}`);
    if (hashBuffer(fs.readFileSync(file)) !== skill.content_hash || skill.content_hash !== source.content_hash) throw new Error(`Staged vault hash mismatch: ${skill.id}`);
  }
  return manifestPath;
}

function installNewVault(live, stubPlan, snapshot, tar, fingerprint) {
  const parent = path.dirname(VAULT);
  assertPathHasNoLinks(parent, 'Vault parent');
  fs.mkdirSync(parent, { recursive: true });
  const stage = exclusiveDirectory(parent, `${path.basename(VAULT)}.staging-`);
  const stubStage = exclusiveDirectory(parent, '.skill-router-stubs-');
  let stageMoved = false;
  try {
    const routerDir = path.join(stage, '.router');
    fs.mkdirSync(routerDir, { recursive: true });
    const sourceManifestPath = path.join(routerDir, 'source-manifest.json');
    fs.writeFileSync(sourceManifestPath, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
    const migrationManifest = path.join(routerDir, 'migration-manifest.json');
    const migration = migrate({
      ids: live.skills.map(skill => skill.id),
      vault: stage,
      stubOut: stubStage,
      manifestOut: migrationManifest,
      manifestPath: sourceManifestPath,
    });
    const stubContents = new Map();
    for (const entry of migration.entries) stubContents.set(entry.id, fs.readFileSync(entry.stubPath, 'utf8'));
    fs.rmSync(migrationManifest, { force: true });
    const stagedManifest = path.join(stage, '.router', 'vault-manifest.json');
    regenerate(stage, stagedManifest, { sourceRoot: VAULT });
    validateStagedVault(stage, VAULT, live);
    const receipt = {
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      createdAt: new Date().toISOString(),
      vault: VAULT,
      serverId: SERVER_ID,
      roots: ROOTS,
      snapshot,
      tar,
      mcpFingerprint: fingerprint,
      codexBlockHash: hashBuffer(Buffer.from(codexBlock(path.join(VAULT, '.router', 'vault-manifest.json'), fingerprint), 'utf8')),
      codexSectionHash: hashBuffer(Buffer.from(codexSection(path.join(VAULT, '.router', 'vault-manifest.json'), fingerprint), 'utf8')),
      managedStubs: stubPlan.map(item => ({ id: item.id, sourceRoot: item.sourceRoot, path: item.path })),
    };
    fs.writeFileSync(path.join(stage, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    if (fs.existsSync(VAULT)) throw new Error(`Vault appeared while staging the install: ${VAULT}`);
    fs.renameSync(stage, VAULT);
    stageMoved = true;
    if (!samePath(fs.realpathSync.native(VAULT), receipt.vault)) throw new Error('Installed vault realpath does not match its receipt');
    return stubContents;
  } finally {
    if (!stageMoved && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    if (fs.existsSync(stubStage)) fs.rmSync(stubStage, { recursive: true, force: true });
  }
}

function replaceWithStubs(plan, contents) {
  for (const item of plan) {
    assertPathHasNoLinks(item.target, `Stub target for ${item.id}`);
    const stat = fs.lstatSync(item.target);
    if (stat.isSymbolicLink()) throw new Error(`Stub target became a symlink or junction: ${item.target}`);
    if (!stat.isFile() || hashBuffer(fs.readFileSync(item.target)) !== hashBuffer(item.content)) throw new Error(`Stub target changed after installation planning: ${item.id}`);
    const stub = contents.get(item.id);
    if (typeof stub !== 'string') throw new Error(`Generated stub is missing for ${item.id}`);
  }
  for (const item of plan) fs.writeFileSync(item.target, contents.get(item.id), 'utf8');
  log('4/5', `stubbed ${plan.length} manifest-selected SKILL.md files`);
}

function main() {
  const requestedHome = args.home ? path.resolve(expandHome(String(args.home))) : os.homedir();
  if (!fs.existsSync(requestedHome) || !fs.statSync(requestedHome).isDirectory()) throw new Error(`Home directory not found: ${requestedHome}`);
  HOME_DIR = fs.realpathSync.native(requestedHome);
  HERE = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
  SERVER_ABS = path.join(HERE, SERVER_REL);
  SERVER_ID = String(args['server-id'] || 'skill-router');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(SERVER_ID)) throw new Error('Server id must contain only letters, digits, underscore, or hyphen');
  ROOTS = buildRootPlan();
  VAULT = canonicalTarget(args.vault ? userPath(args.vault) : path.join(HOME_DIR, '.zcode', 'skill-store'), 'Vault path');
  WORKSPACE = HERE;
  assertVaultLocation();
  AGENTS = buildAgents();
  if (!fs.existsSync(SERVER_ABS)) throw new Error(`MCP server not found: ${SERVER_ABS}`);
  log('0/5', `roots: ${ROOTS.join(', ')}`);
  log('0/5', `vault: ${VAULT}${DRY ? ' (dry-run)' : ''}`);

  const existing = detectExistingInstallation();
  if (existing.mode === 'idempotent') {
    console.log(`skill-router is already installed at ${VAULT}; all recorded scan-root targets are stubs.`);
    console.log('No files were changed. To reinstall, restore the recorded snapshot (or uninstall) and run setup again.');
    return;
  }

  const live = generateManifest(ROOTS);
  validateLiveManifest(live);
  const stubPlan = buildStubPlan(live);
  if (existing.mode === 'repair') verifyRepair(existing, live, stubPlan);
  const tar = detectTar();
  log('1/5', `tar: ${tar.version} (${tar.pathMode} paths)`);

  const manifestPath = path.join(VAULT, '.router', 'vault-manifest.json');
  const fingerprint = existing.receipt?.mcpFingerprint || crypto.randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new Error('Install receipt has an invalid MCP ownership fingerprint');
  const registrationPlans = planAgentRegistrations(manifestPath, fingerprint);

  if (DRY) {
    const preview = path.join(HOME_DIR, 'skill-router-backups', `snapshot-${snapshotStamp()}-<random>`);
    log('1/5', `would create an exclusive snapshot at ${preview}`);
    log('2/5', existing.mode === 'repair' ? `would verify and reuse ${live.skills.length} vault skills` : `would stage and migrate ${live.skills.length} skills into ${VAULT}`);
    log('3/5', `would validate and atomically install ${manifestPath}`);
    log('4/5', `would replace ${stubPlan.length} exact manifest-selected SKILL.md files`);
    applyAgentRegistrations(registrationPlans, 'dry-run');
    console.log('Dry run complete; no files were changed.');
    return;
  }

  const snapshot = createSnapshot(tar);
  let stubContents;
  if (existing.mode === 'new') {
    stubContents = installNewVault(live, stubPlan, snapshot, tar, fingerprint);
    log('2/5', `staged and migrated ${live.skills.length} skills`);
    log('3/5', `vault manifest and receipt installed atomically at ${VAULT}`);
  } else {
    stubContents = new Map(stubPlan.map(item => [item.id, stubFromContent(item.content.toString('utf8'), item.id, { forceId: true })]));
    log('2/5', `verified and reused ${live.skills.length} existing vault skills`);
    log('3/5', `vault manifest remains ${manifestPath}`);
  }
  replaceWithStubs(stubPlan, stubContents);
  applyAgentRegistrations(registrationPlans, path.basename(snapshot));

  console.log('\nInstall complete. Restart agent sessions to use skill_discover, skill_load, and skill_health.');
  console.log(`Rollback: node rollback.mjs --snapshot ${snapshot} --roots ${ROOTS.join(',')}`);
}

try { main(); }
catch (error) {
  console.error(`ABORT: ${error.message}`);
  process.exitCode = 2;
}
