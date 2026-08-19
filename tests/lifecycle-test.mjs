#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-router-lifecycle-'));
const zcodeRoot = path.join(sandboxHome, '.zcode', 'skills');
const agentsRoot = path.join(sandboxHome, '.agents', 'skill-bank');
const rootsArg = `${zcodeRoot},${agentsRoot}`;
const vault = path.join(sandboxHome, '.zcode', 'skill-store');
const serverId = 'sandbox-router';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function runCli(script, cliArgs = [], { expectFailure = false } = {}) {
  assert(!cliArgs.includes('--home'), 'runCli owns the mandatory sandbox --home argument');
  const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...cliArgs, '--home', sandboxHome], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
  });
  const detail = `${result.stdout || ''}${result.stderr || ''}`;
  if (expectFailure) {
    assert.notStrictEqual(result.status, 0, `${script} unexpectedly succeeded:\n${detail}`);
  } else {
    assert.strictEqual(result.status, 0, `${script} failed with ${result.status}:\n${detail}`);
  }
  return { ...result, detail };
}

function treeDigest(root) {
  const records = [];
  function walk(current, relative = '') {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const rel = path.join(relative, entry.name).replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) records.push(`L ${rel} ${fs.readlinkSync(absolute)}`);
      else if (stat.isDirectory()) { records.push(`D ${rel}`); walk(absolute, rel); }
      else records.push(`F ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
    }
  }
  walk(root);
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

function snapshotDirectories() {
  const parent = path.join(sandboxHome, 'skill-router-backups');
  return fs.existsSync(parent)
    ? fs.readdirSync(parent).filter(name => name.startsWith('snapshot-')).map(name => path.join(parent, name)).sort()
    : [];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setupArgs() {
  return ['--roots', rootsArg, '--vault', vault, '--agents', 'zcode,codex,claude,opencode', '--server-id', serverId];
}

async function mcpSmoke(manifest) {
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_load', arguments: { id: 'alpha' } } };
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'mcp', 'server.js')], {
    cwd: repoRoot,
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, SKILL_ROUTER_MANIFEST: manifest },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  assert.strictEqual(reply.result.isError, undefined, JSON.stringify(reply));
  assert.match(reply.result.structuredContent.content, /Alpha lifecycle body/);
}

const alphaOriginal = '---\nname: alpha\ndescription: Alpha lifecycle skill\n---\n\n# Alpha\nAlpha lifecycle body.\n';
const betaZcodeOriginal = '---\nname: beta\ndescription: Beta zcode variant\n---\n\n# Beta zcode\n';
const betaAgentsOriginal = '---\nname: beta\ndescription: Beta agents variant\n---\n\n# Beta agents\n';

try {
  write(path.join(zcodeRoot, 'alpha-directory', 'SKILL.md'), alphaOriginal);
  write(path.join(zcodeRoot, 'beta-zcode', 'SKILL.md'), betaZcodeOriginal);
  write(path.join(agentsRoot, 'beta-agents', 'SKILL.md'), betaAgentsOriginal);
  write(path.join(zcodeRoot, 'alpha-directory', 'references', 'guide.md'), '# Lifecycle guide\n');

  const zcodeConfigPath = path.join(sandboxHome, '.zcode', 'cli', 'config.json');
  const originalZcode = `${JSON.stringify({ marker: 'zcode', mcp: { servers: { keep: { command: 'keep' } } } }, null, 2)}\n`;
  write(zcodeConfigPath, originalZcode);
  write(path.join(sandboxHome, '.claude.json'), `${JSON.stringify({ marker: 'claude', mcpServers: { keep: { command: 'keep' } } }, null, 2)}\n`);
  write(path.join(sandboxHome, '.config', 'opencode', 'opencode.json'), `${JSON.stringify({ marker: 'opencode', mcp: { keep: { command: ['keep'] } } }, null, 2)}\n`);
  const originalCodex = 'model = "test"\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.sandbox-router-extra]\ncommand = "other"\n';
  write(path.join(sandboxHome, '.codex', 'config.toml'), originalCodex);

  const beforeDryRun = treeDigest(sandboxHome);
  runCli('setup.mjs', [...setupArgs(), '--dry-run']);
  assert.strictEqual(treeDigest(sandboxHome), beforeDryRun, 'setup --dry-run must perform zero writes');
  runCli('setup.mjs', ['--roots', ' , ', '--vault', vault, '--dry-run'], { expectFailure: true });
  assert.deepStrictEqual(snapshotDirectories(), []);

  write(zcodeConfigPath, '{ invalid json');
  const beforeSkipMcp = treeDigest(sandboxHome);
  runCli('setup.mjs', [...setupArgs(), '--skip-mcp', '--dry-run']);
  assert.strictEqual(treeDigest(sandboxHome), beforeSkipMcp, '--skip-mcp inspected or changed an agent config');
  runCli('setup.mjs', setupArgs(), { expectFailure: true });
  assert.deepStrictEqual(snapshotDirectories(), [], 'MCP registration preflight failed after creating a snapshot');
  assert(!fs.existsSync(vault), 'MCP registration preflight failed after installing the vault');
  write(zcodeConfigPath, originalZcode);

  const realRoot = path.join(sandboxHome, 'real-link-root');
  const linkedRoot = path.join(sandboxHome, 'linked-skills');
  fs.mkdirSync(realRoot);
  try {
    fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = runCli('setup.mjs', ['--roots', linkedRoot, '--vault', path.join(sandboxHome, 'link-vault'), '--dry-run'], { expectFailure: true });
    assert.match(linked.detail, /symlink|junction/i);
  } finally {
    if (fs.existsSync(linkedRoot)) fs.rmSync(linkedRoot, { force: true });
  }

  const firstSetup = runCli('setup.mjs', setupArgs());
  assert.match(firstSetup.detail, /install complete/i);
  const [firstSnapshot] = snapshotDirectories();
  assert(firstSnapshot);
  assert.match(path.basename(firstSnapshot), /^snapshot-.+-[a-f0-9]{12}$/);

  const receiptPath = path.join(vault, 'install-receipt.json');
  const receipt = readJson(receiptPath);
  assert.strictEqual(receipt.schemaVersion, 1);
  assert.strictEqual(receipt.vault, fs.realpathSync.native(vault));
  assert.strictEqual(receipt.serverId, serverId);
  assert.deepStrictEqual(receipt.roots, [fs.realpathSync.native(zcodeRoot), fs.realpathSync.native(agentsRoot)]);
  assert(!Number.isNaN(Date.parse(receipt.createdAt)));
  assert.match(receipt.toolVersion, /^\d+\.\d+\.\d+$/);
  assert(['bsdtar', 'gnu-tar'].includes(receipt.tar.implementation));
  assert.strictEqual(typeof receipt.tar.version, 'string');
  assert(receipt.tar.version.length > 0);
  assert.match(receipt.mcpFingerprint, /^[a-f0-9]{32}$/);
  assert.deepStrictEqual(receipt.managedStubs.map(item => item.id).sort(), ['alpha', 'beta']);

  const snapshotRecord = readJson(path.join(firstSnapshot, 'snapshot.json'));
  assert.strictEqual(snapshotRecord.schemaVersion, 1);
  assert.deepStrictEqual(snapshotRecord.roots.map(item => item.root), receipt.roots);
  assert.strictEqual(new Set(snapshotRecord.roots.map(item => item.archive)).size, 2);
  for (const item of snapshotRecord.roots) {
    assert.match(item.archive, /^root-\d+\.tar\.gz$/);
    assert(fs.statSync(path.join(firstSnapshot, item.archive)).isFile());
  }

  const alphaStubPath = path.join(zcodeRoot, 'alpha-directory', 'SKILL.md');
  const betaWinningStubPath = path.join(agentsRoot, 'beta-agents', 'SKILL.md');
  assert.match(fs.readFileSync(alphaStubPath, 'utf8'), /skill_load\('alpha'\)/);
  assert.match(fs.readFileSync(betaWinningStubPath, 'utf8'), /skill_load\('beta'\)/);
  assert.strictEqual(fs.readFileSync(path.join(zcodeRoot, 'beta-zcode', 'SKILL.md'), 'utf8'), betaZcodeOriginal, 'overridden duplicate must not be stubbed');

  const codexAfterSetup = fs.readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf8');
  assert.match(codexAfterSetup, new RegExp(`# skill-router:begin ${serverId} ${receipt.mcpFingerprint}`));
  assert.match(codexAfterSetup, new RegExp(`# skill-router:end ${serverId} ${receipt.mcpFingerprint}`));
  assert.match(codexAfterSetup, /\[mcp_servers\.sandbox-router-extra\]/);

  const installedConfigs = new Map([
    [zcodeConfigPath, fs.readFileSync(zcodeConfigPath, 'utf8')],
    [path.join(sandboxHome, '.claude.json'), fs.readFileSync(path.join(sandboxHome, '.claude.json'), 'utf8')],
    [path.join(sandboxHome, '.config', 'opencode', 'opencode.json'), fs.readFileSync(path.join(sandboxHome, '.config', 'opencode', 'opencode.json'), 'utf8')],
    [path.join(sandboxHome, '.codex', 'config.toml'), codexAfterSetup],
  ]);
  const unmarkedOwnedCodex = codexAfterSetup.split(/\r?\n/)
    .filter(line => !line.startsWith(`# skill-router:begin ${serverId} `) && !line.startsWith(`# skill-router:end ${serverId} `))
    .join('\n');
  write(path.join(sandboxHome, '.codex', 'config.toml'), unmarkedOwnedCodex);
  runCli('uninstall.mjs', ['--mcp-only', '--vault', vault]);
  const codexAfterLegacyOwnershipRemoval = fs.readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf8');
  assert(!codexAfterLegacyOwnershipRemoval.includes(`[mcp_servers.${serverId}]`));
  assert.match(codexAfterLegacyOwnershipRemoval, /\[mcp_servers\.sandbox-router-extra\]/);
  for (const [configPath, content] of installedConfigs) write(configPath, content);

  const vaultAlias = path.join(sandboxHome, 'vault-alias');
  try {
    fs.symlinkSync(vault, vaultAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasPurge = runCli('uninstall.mjs', ['--mcp-only', '--purge-vault', '--vault', vaultAlias], { expectFailure: true });
    assert.match(aliasPurge.detail, /symlink|junction|alias/i);
    assert(fs.existsSync(vault));
  } finally {
    if (fs.existsSync(vaultAlias)) fs.rmSync(vaultAlias, { force: true });
  }

  const blockedPurge = runCli('uninstall.mjs', ['--mcp-only', '--purge-vault', '--vault', vault], { expectFailure: true });
  assert.match(blockedPurge.detail, /stub/i);
  assert(fs.existsSync(vault));
  assert.match(fs.readFileSync(alphaStubPath, 'utf8'), /skill_load/);

  const beforeUninstallDryRun = treeDigest(sandboxHome);
  runCli('uninstall.mjs', ['--snapshot', firstSnapshot, '--roots', rootsArg, '--purge-vault', '--vault', vault, '--dry-run']);
  assert.strictEqual(treeDigest(sandboxHome), beforeUninstallDryRun, 'uninstall --dry-run must perform zero writes');

  const badRoots = runCli('rollback.mjs', ['--snapshot', firstSnapshot, '--roots', zcodeRoot], { expectFailure: true });
  assert.match(badRoots.detail, /roots.*match|mismatch/i);
  assert.match(fs.readFileSync(alphaStubPath, 'utf8'), /skill_load/);

  const corruptArchive = path.join(firstSnapshot, snapshotRecord.roots[1].archive);
  const savedArchive = fs.readFileSync(corruptArchive);
  fs.writeFileSync(corruptArchive, 'not a tar archive', 'utf8');
  const corruptRestore = runCli('rollback.mjs', ['--snapshot', firstSnapshot, '--roots', rootsArg], { expectFailure: true });
  assert.match(corruptRestore.detail, /archive|tar|snapshot/i);
  assert.match(fs.readFileSync(alphaStubPath, 'utf8'), /skill_load/, 'first root changed before all archives validated');
  assert.match(fs.readFileSync(betaWinningStubPath, 'utf8'), /skill_load/, 'second root changed after invalid archive');
  fs.writeFileSync(corruptArchive, savedArchive);

  await mcpSmoke(path.join(vault, '.router', 'vault-manifest.json'));

  runCli('rollback.mjs', ['--snapshot', firstSnapshot, '--roots', rootsArg]);
  assert.strictEqual(fs.readFileSync(alphaStubPath, 'utf8'), alphaOriginal);
  assert.strictEqual(fs.readFileSync(path.join(zcodeRoot, 'beta-zcode', 'SKILL.md'), 'utf8'), betaZcodeOriginal);
  assert.strictEqual(fs.readFileSync(betaWinningStubPath, 'utf8'), betaAgentsOriginal);

  const snapshotCountBeforeReinstall = snapshotDirectories().length;
  runCli('setup.mjs', setupArgs());
  const snapshotsAfterReinstall = snapshotDirectories();
  assert.strictEqual(snapshotsAfterReinstall.length, snapshotCountBeforeReinstall + 1);
  const secondSnapshot = snapshotsAfterReinstall.find(item => item !== firstSnapshot);
  assert(secondSnapshot);
  assert.match(fs.readFileSync(alphaStubPath, 'utf8'), /skill_load\('alpha'\)/);

  const createdAtBeforeIdempotentRun = readJson(receiptPath).createdAt;
  const snapshotCountBeforeIdempotentRun = snapshotDirectories().length;
  const idempotent = runCli('setup.mjs', setupArgs());
  assert.match(idempotent.detail, /already installed/i);
  assert.match(idempotent.detail, /reinstall/i);
  assert.strictEqual(snapshotDirectories().length, snapshotCountBeforeIdempotentRun, 'idempotent setup created a snapshot');
  assert.strictEqual(readJson(receiptPath).createdAt, createdAtBeforeIdempotentRun);

  const installedCodex = fs.readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf8');
  assert.strictEqual((installedCodex.match(/# skill-router:begin/g) || []).length, 1);

  runCli('uninstall.mjs', ['--snapshot', secondSnapshot, '--roots', rootsArg, '--purge-vault', '--vault', vault]);
  assert(!fs.existsSync(vault));
  assert.strictEqual(fs.readFileSync(alphaStubPath, 'utf8'), alphaOriginal);
  assert.strictEqual(fs.readFileSync(betaWinningStubPath, 'utf8'), betaAgentsOriginal);

  const finalZcode = readJson(path.join(sandboxHome, '.zcode', 'cli', 'config.json'));
  const finalClaude = readJson(path.join(sandboxHome, '.claude.json'));
  const finalOpenCode = readJson(path.join(sandboxHome, '.config', 'opencode', 'opencode.json'));
  assert(finalZcode.mcp.servers.keep);
  assert(!finalZcode.mcp.servers[serverId]);
  assert(finalClaude.mcpServers.keep);
  assert(!finalClaude.mcpServers[serverId]);
  assert(finalOpenCode.mcp.keep);
  assert(!finalOpenCode.mcp[serverId]);
  const finalCodex = fs.readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf8');
  assert.match(finalCodex, /\[mcp_servers\.keep\]/);
  assert.match(finalCodex, /\[mcp_servers\.sandbox-router-extra\]/);
  assert(!finalCodex.includes(`[mcp_servers.${serverId}]`));
  assert(!finalCodex.includes('# skill-router:begin'));

  const legacyCodex = `${finalCodex}\n[mcp_servers.${serverId}]\ncommand = "legacy"\n`;
  write(path.join(sandboxHome, '.codex', 'config.toml'), legacyCodex);
  write(path.join(vault, 'install-receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    toolVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    vault,
    serverId,
    roots: [zcodeRoot, agentsRoot],
  }, null, 2)}\n`);
  const legacyResult = runCli('uninstall.mjs', ['--mcp-only', '--server-id', serverId]);
  assert.match(legacyResult.detail, /manual confirmation required/i);
  assert.strictEqual(fs.readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf8'), legacyCodex);

  write(path.join(sandboxHome, 'install-receipt.json'), `${JSON.stringify({
    schemaVersion: 1,
    toolVersion: '2.1.0',
    createdAt: new Date().toISOString(),
    vault: fs.realpathSync.native(sandboxHome),
    serverId,
    roots: [],
    tar: { implementation: 'gnu-tar', version: 'test', pathMode: 'native' },
    managedStubs: [],
  }, null, 2)}\n`);
  write(path.join(sandboxHome, 'purge-sentinel.txt'), 'must survive');
  const homePurge = runCli('uninstall.mjs', ['--mcp-only', '--purge-vault', '--vault', sandboxHome], { expectFailure: true });
  assert.match(homePurge.detail, /home|filesystem root|protected/i);
  assert.strictEqual(fs.readFileSync(path.join(sandboxHome, 'purge-sentinel.txt'), 'utf8'), 'must survive');

  process.stdout.write('PASS sandbox lifecycle test\n');
} finally {
  const resolvedSandbox = path.resolve(sandboxHome);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert(resolvedSandbox.startsWith(`${resolvedTemp}${path.sep}`));
  assert(path.basename(resolvedSandbox).startsWith('skill-router-lifecycle-'));
  fs.rmSync(resolvedSandbox, { recursive: true, force: true });
}
