#!/usr/bin/env node

/**
 * Drupal MCP Server
 *
 * Talks to a Drupal site's core JSON:API (/jsonapi) over HTTPS Basic
 * auth. Works inside Claude Code via plugin install or standalone via
 * `node drupal-mcp.js` with env vars set.
 *
 * Auth: HTTP Basic. Create a dedicated `mcp_bot` user in Drupal with
 * a role scoped to only the bundles / fields you want to expose.
 *
 * Tools:
 *   list_nodes      — list nodes of a bundle, optional filters + sort
 *   get_node        — fetch one node by uuid (or numeric id w/ bundle)
 *   create_node     — create a node
 *   update_node     — update an existing node
 *   delete_node     — delete a node by uuid
 *   list_taxonomy_terms — list terms in a vocabulary
 *   list_users      — list users
 *   query_jsonapi   — escape hatch: arbitrary GET against /jsonapi/*
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const args = process.argv.slice(2);

function argOrEnv(flag, envName, fallback = undefined) {
  const found = args.find(a => a.startsWith(`--${flag}=`));
  if (found) return found.split('=').slice(1).join('=');
  const envVal = process.env[envName];
  if (envVal && /^\$\{[^}]+\}$/.test(envVal)) return fallback;
  return envVal ?? fallback;
}

const config = {
  baseUrl: argOrEnv('base-url', 'DRUPAL_BASE_URL'),
  user: argOrEnv('user', 'DRUPAL_USER'),
  password: argOrEnv('password', 'DRUPAL_PASSWORD'),
  jsonapiPrefix: argOrEnv('jsonapi-prefix', 'DRUPAL_JSONAPI_PREFIX', '/jsonapi'),
  timeout: parseInt(argOrEnv('timeout', 'REQUEST_TIMEOUT', '30000'), 10),
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`
Drupal MCP Server — read/write Drupal nodes, taxonomy, users via JSON:API.

Usage: node drupal-mcp.js [options]

Options:
  --base-url=URL         Drupal base URL (env: DRUPAL_BASE_URL)
  --user=USER            Drupal username (env: DRUPAL_USER)
  --password=PASS        Drupal password (env: DRUPAL_PASSWORD)
  --jsonapi-prefix=/p    JSON:API URL prefix (env: DRUPAL_JSONAPI_PREFIX, default /jsonapi)
  --timeout=MS           Request timeout in ms (env: REQUEST_TIMEOUT, default 30000)
  -h, --help             Show this help

The Drupal site must have the core 'jsonapi' module enabled, and the
configured user must have permission to perform the requested actions.
`);
  process.exit(0);
}

const errors = [];
if (!config.baseUrl) errors.push('DRUPAL_BASE_URL is required');
if (!config.user) errors.push('DRUPAL_USER is required');
if (!config.password) errors.push('DRUPAL_PASSWORD is required');
if (config.baseUrl) {
  try { new URL(config.baseUrl); }
  catch { errors.push(`Invalid DRUPAL_BASE_URL: ${config.baseUrl}`); }
}
if (errors.length) {
  console.error('Configuration error:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}

console.error('Drupal MCP Server configuration:', {
  baseUrl: config.baseUrl,
  user: config.user,
  password: config.password ? '***' : 'NOT SET',
  jsonapiPrefix: config.jsonapiPrefix,
});

// ============================================================================
// JSON:API CLIENT
// ============================================================================

const baseUrlNoSlash = config.baseUrl.replace(/\/$/, '');
const apiBase = baseUrlNoSlash + config.jsonapiPrefix.replace(/\/$/, '');
const authHeader = 'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');

async function jsonapiRequest(method, path, { query, body } = {}) {
  let url = apiBase + (path.startsWith('/') ? path : '/' + path);
  if (query && Object.keys(query).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      usp.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    url += (url.includes('?') ? '&' : '?') + usp.toString();
  }
  const headers = {
    'Authorization': authHeader,
    'Accept': 'application/vnd.api+json',
  };
  const init = { method, headers, signal: AbortSignal.timeout(config.timeout) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/vnd.api+json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch { /* leave as text */ }
  if (!res.ok) {
    const err = json?.errors?.[0];
    const detail = err ? `${err.title || ''}: ${err.detail || ''}` : (text.slice(0, 400) || res.statusText);
    throw new Error(`Drupal JSON:API ${method} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}

// JSON:API filter / sort / pagination → query params helper.
function buildListQuery({ filter, sort, limit, offset, include, fields } = {}) {
  const q = {};
  if (filter && typeof filter === 'object') {
    // Accepts shorthand: { field_category: { value: '1' } } -> filter[field_category]=1
    // Or full path: { 'filter[status][value]': 1 }
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('filter[')) { q[k] = v; continue; }
      if (v && typeof v === 'object' && 'value' in v) {
        q[`filter[${k}][value]`] = v.value;
        if (v.operator) q[`filter[${k}][operator]`] = v.operator;
      } else {
        q[`filter[${k}]`] = v;
      }
    }
  }
  if (sort) q['sort'] = sort;
  if (limit) q['page[limit]'] = String(limit);
  if (offset) q['page[offset]'] = String(offset);
  if (include) q['include'] = Array.isArray(include) ? include.join(',') : include;
  if (fields && typeof fields === 'object') {
    for (const [type, list] of Object.entries(fields)) {
      q[`fields[${type}]`] = Array.isArray(list) ? list.join(',') : list;
    }
  }
  return q;
}

// Compact a JSON:API resource into a friendlier shape for the model.
function summarizeResource(r) {
  if (!r || typeof r !== 'object') return r;
  return {
    id: r.id,
    type: r.type,
    ...r.attributes,
    _relationships: r.relationships ? Object.fromEntries(
      Object.entries(r.relationships).map(([k, v]) => [k, v.data ?? null])
    ) : undefined,
    _links: r.links ?? undefined,
  };
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

const handlers = {
  async list_nodes({ bundle, filter, sort = '-created', limit = 25, offset, include, fields }) {
    if (!bundle) throw new Error('bundle is required (e.g. "article", "page")');
    const json = await jsonapiRequest('GET', `/node/${bundle}`, {
      query: buildListQuery({ filter, sort, limit, offset, include, fields }),
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: json.meta?.count ?? json.data?.length ?? 0,
          links: { next: json.links?.next?.href, prev: json.links?.prev?.href },
          items: (json.data || []).map(summarizeResource),
        }, null, 2),
      }],
    };
  },

  async get_node({ bundle, uuid }) {
    if (!bundle || !uuid) throw new Error('bundle and uuid are required');
    const json = await jsonapiRequest('GET', `/node/${bundle}/${uuid}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(summarizeResource(json.data), null, 2) }],
    };
  },

  async create_node({ bundle, attributes, relationships }) {
    if (!bundle || !attributes) throw new Error('bundle and attributes are required');
    const body = {
      data: {
        type: `node--${bundle}`,
        attributes,
        ...(relationships ? { relationships } : {}),
      },
    };
    const json = await jsonapiRequest('POST', `/node/${bundle}`, { body });
    return {
      content: [{ type: 'text', text: JSON.stringify(summarizeResource(json.data), null, 2) }],
    };
  },

  async update_node({ bundle, uuid, attributes, relationships }) {
    if (!bundle || !uuid) throw new Error('bundle and uuid are required');
    const body = {
      data: {
        type: `node--${bundle}`,
        id: uuid,
        ...(attributes ? { attributes } : {}),
        ...(relationships ? { relationships } : {}),
      },
    };
    const json = await jsonapiRequest('PATCH', `/node/${bundle}/${uuid}`, { body });
    return {
      content: [{ type: 'text', text: JSON.stringify(summarizeResource(json.data), null, 2) }],
    };
  },

  async delete_node({ bundle, uuid }) {
    if (!bundle || !uuid) throw new Error('bundle and uuid are required');
    await jsonapiRequest('DELETE', `/node/${bundle}/${uuid}`);
    return { content: [{ type: 'text', text: `Deleted node--${bundle}/${uuid}` }] };
  },

  async list_taxonomy_terms({ vocabulary, filter, sort = 'weight', limit = 50 }) {
    if (!vocabulary) throw new Error('vocabulary is required');
    const json = await jsonapiRequest('GET', `/taxonomy_term/${vocabulary}`, {
      query: buildListQuery({ filter, sort, limit }),
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify((json.data || []).map(summarizeResource), null, 2),
      }],
    };
  },

  async list_users({ filter, sort = '-created', limit = 25 }) {
    const json = await jsonapiRequest('GET', `/user/user`, {
      query: buildListQuery({ filter, sort, limit }),
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify((json.data || []).map(summarizeResource), null, 2),
      }],
    };
  },

  async query_jsonapi({ path, query }) {
    if (!path) throw new Error('path is required (e.g. "/node/article" or "/taxonomy_term/category")');
    const json = await jsonapiRequest('GET', path, { query });
    return {
      content: [{ type: 'text', text: JSON.stringify(json, null, 2) }],
    };
  },
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const filterDescription = `Optional filter object. Shortcut form: { field_name: { value: 'x', operator: '=' } } or { field_name: 'x' }. Pre-encoded form: { 'filter[status][value]': 1 } also accepted.`;

const TOOLS = [
  {
    name: 'drupal_list_nodes',
    description: 'List nodes of a given bundle (content type). Returns a paginated set of nodes with their attributes flattened. Default sort is by created date desc.',
    inputSchema: {
      type: 'object',
      required: ['bundle'],
      properties: {
        bundle: { type: 'string', description: 'Content type machine name (e.g. "article", "page")' },
        filter: { type: 'object', description: filterDescription },
        sort: { type: 'string', description: 'Sort spec (e.g. "-created", "title"). Default "-created".' },
        limit: { type: 'integer', description: 'Page size (default 25)' },
        offset: { type: 'integer', description: 'Pagination offset' },
        include: { type: ['string', 'array'], description: 'Relationships to include (e.g. "field_category" or ["field_image","uid"])' },
        fields: { type: 'object', description: 'Sparse fieldsets keyed by JSON:API type, e.g. { "node--article": ["title","field_summary"] }' },
      },
    },
  },
  {
    name: 'drupal_get_node',
    description: 'Fetch a single node by bundle + UUID.',
    inputSchema: {
      type: 'object',
      required: ['bundle', 'uuid'],
      properties: {
        bundle: { type: 'string' },
        uuid: { type: 'string' },
      },
    },
  },
  {
    name: 'drupal_create_node',
    description: 'Create a new node. Pass attributes (and optional relationships) using JSON:API field names.',
    inputSchema: {
      type: 'object',
      required: ['bundle', 'attributes'],
      properties: {
        bundle: { type: 'string' },
        attributes: { type: 'object', description: 'e.g. { "title": "...", "body": { "value": "...", "format": "basic_html" }, "status": true }' },
        relationships: { type: 'object', description: 'JSON:API relationships object (optional)' },
      },
    },
  },
  {
    name: 'drupal_update_node',
    description: 'Patch an existing node by UUID. Pass only the attributes / relationships you want to change.',
    inputSchema: {
      type: 'object',
      required: ['bundle', 'uuid'],
      properties: {
        bundle: { type: 'string' },
        uuid: { type: 'string' },
        attributes: { type: 'object' },
        relationships: { type: 'object' },
      },
    },
  },
  {
    name: 'drupal_delete_node',
    description: 'Delete a node by bundle + UUID. Irreversible.',
    inputSchema: {
      type: 'object',
      required: ['bundle', 'uuid'],
      properties: {
        bundle: { type: 'string' },
        uuid: { type: 'string' },
      },
    },
  },
  {
    name: 'drupal_list_taxonomy_terms',
    description: 'List terms in a vocabulary (e.g. "category", "tags"). Default sort is "weight".',
    inputSchema: {
      type: 'object',
      required: ['vocabulary'],
      properties: {
        vocabulary: { type: 'string', description: 'Vocabulary machine name' },
        filter: { type: 'object', description: filterDescription },
        sort: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'drupal_list_users',
    description: 'List Drupal users. Requires the configured account to have permission to view users.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: filterDescription },
        sort: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'drupal_query_jsonapi',
    description: 'Escape hatch: arbitrary GET against the JSON:API. Use when the higher-level tools do not cover what you need (custom resources, /jsonapi/index, etc.).',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'JSON:API path relative to the prefix, e.g. "/node/article" or "/taxonomy_term/category"' },
        query: { type: 'object', description: 'Raw query parameters (filter[...], sort, page[limit], etc.)' },
      },
    },
  },
];

// Map tool names to handler keys.
const handlerLookup = {
  drupal_list_nodes: 'list_nodes',
  drupal_get_node: 'get_node',
  drupal_create_node: 'create_node',
  drupal_update_node: 'update_node',
  drupal_delete_node: 'delete_node',
  drupal_list_taxonomy_terms: 'list_taxonomy_terms',
  drupal_list_users: 'list_users',
  drupal_query_jsonapi: 'query_jsonapi',
};

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: 'drupal-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error(`Listing ${TOOLS.length} tools`);
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const handlerKey = handlerLookup[name];
  if (!handlerKey || !handlers[handlerKey]) {
    throw new Error(`Unknown tool: ${name}`);
  }
  console.error(`Calling tool: ${name}`);
  try {
    return await handlers[handlerKey](rawArgs || {});
  }
  catch (err) {
    const cause = err.cause?.message || err.cause?.code || '';
    const msg = err.message || String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: cause ? `Error: ${msg} (cause: ${cause})` : `Error: ${msg}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Drupal MCP Server running on stdio');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
