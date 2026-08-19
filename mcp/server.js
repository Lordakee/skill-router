#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { SkillRouterV2 } = require('../lib/router-core.js');

const router = new SkillRouterV2();
// Startup self-check is deliberately non-fatal: health exposes degraded mode to the client.
router.health();

const TOOL_DEFINITIONS = [
  {
    name: 'skill_discover',
    description: 'Find skills relevant to a task query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'skill_load',
    description: 'Load one skill after verifying its manifest content hash.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'skill_health',
    description: 'Report manifest and router health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function errorReply(id, code, message, data) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })}\n`);
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function classifyToolError(error) {
  const detail = String(error && error.message ? error.message : error || 'Unknown error').toLowerCase();
  if (detail.includes('hash mismatch')) return 'SR_HASH_MISMATCH';
  if (detail.includes('not found') || detail.includes('unavailable')) return 'SR_NOT_FOUND';
  if (detail.includes('too large')) return 'SR_FILE_REJECTED';
  if (detail.includes('unknown tool') || detail.includes('requires a')) return 'SR_INVALID_REQUEST';
  if (/path|traversal|absolute|symlink|junction|escape|invalid skill id|source root/.test(detail)) return 'SR_PATH_REJECTED';
  if (detail.includes('manifest')) return 'SR_MANIFEST_UNAVAILABLE';
  return 'SR_INTERNAL';
}

function toolErrorResult(error) {
  const code = classifyToolError(error);
  const detail = String(error && error.message ? error.message : error || 'Unknown error')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2000);
  process.stderr.write(`[skill-router-v2] tool error ${code}: ${detail}\n`);
  const message = 'Skill operation failed';
  return {
    isError: true,
    content: [{ type: 'text', text: `${message} [${code}]` }],
    structuredContent: { code, message },
  };
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    errorReply(message && message.id !== undefined ? message.id : null, -32600, 'Invalid JSON-RPC request');
    return;
  }
  const id = message.id;
  if (id === undefined) return;
  try {
    if (message.method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'skill-router-v2', version: '2.1.0' }
      });
      return;
    }
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'ping') {
      reply(id, {});
      return;
    }
    if (message.method === 'tools/list') {
      reply(id, { tools: TOOL_DEFINITIONS });
      return;
    }
    if (message.method === 'tools/call') {
      const params = message.params || {};
      const name = params.name;
      const args = params.arguments || {};
      let value;
      if (name === 'skill_discover') {
        if (typeof args.query !== 'string') throw new Error('skill_discover requires a string query');
        // MCP structuredContent must be a JSON object (record), never a bare array.
        value = { results: router.discover(args.query, args.limit) };
      } else if (name === 'skill_load') {
        if (typeof args.id !== 'string') throw new Error('skill_load requires a string id');
        value = await router.loadSkill(args.id);
      } else if (name === 'skill_health') {
        value = router.health();
      } else {
        throw new Error(`Unknown tool: ${String(name)}`);
      }
      reply(id, toolResult(value));
      return;
    }
    errorReply(id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    if (message.method === 'tools/call') {
      reply(id, toolErrorResult(error));
    } else {
      errorReply(id, -32000, error.message);
    }
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();
input.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch (error) { errorReply(null, -32700, `Parse error: ${error.message}`); return; }
  requestQueue = requestQueue
    .then(() => handle(message))
    .catch(() => process.stderr.write('[skill-router-v2] request processing failed\n'));
});

module.exports = { handle, TOOL_DEFINITIONS, router };
