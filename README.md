# drupal-mcp

MCP server for Drupal sites via the core JSON:API. List, search, create, update, and delete nodes / taxonomy terms / users on any Drupal 10/11 site with the `jsonapi` module enabled.

Works two ways:

- **Claude Code plugin** — install via the `lucaspretti-plugins` marketplace and Claude prompts you for the env vars.
- **Standalone MCP** — `node drupal-mcp.js` with env vars set. Plug into Claude Desktop, Cline, or any other MCP-compatible client.

## Why JSON:API and not the older Drupal MCP module?

The contrib `drupal/mcp` module currently has ~250 installs and is in flux ("merging with the MCP Server module"). JSON:API is in Drupal core, stable, and standard. This server is a thin wrapper around endpoints your site already exposes — no new module to maintain on the Drupal side.

## Drupal-side setup (one-time)

### Required modules

```bash
drush en jsonapi serialization basic_auth -y
```

- **`jsonapi`** — exposes `/jsonapi/*` endpoints. Core module.
- **`serialization`** — JSON:API dependency. Core module.
- **`basic_auth`** — required for `Authorization: Basic` header authentication. Core module, **not enabled by default**. Without it, only anonymous reads work; every write returns 401.

### JSON:API writes

By default JSON:API is read-only. If you need create / update / delete, flip the switch:

```bash
drush config:set jsonapi.settings read_only false -y
```

Or in `config/sync/jsonapi.settings.yml` (CMI-managed sites):

```yaml
read_only: false
```

Keep `read_only: true` for read-only deployments — the plugin still works for `drupal_list_*` / `drupal_get_node` / `drupal_query_jsonapi`.

### Bot role + user

Create a dedicated role with the minimum permissions you want to expose. Suggested baseline (`config/sync/user.role.mcp_bot.yml`):

```yaml
langcode: en
status: true
dependencies: {}
id: mcp_bot
label: 'MCP bot'
weight: 10
is_admin: false
permissions:
  - 'access content'
  - 'access user profiles'
  - 'administer nodes'
  - 'administer taxonomy'
  - 'view own unpublished content'
```

Then `drush user:create mcp_bot --password='<strong-pw>'` and `drush user:role:add mcp_bot mcp_bot`. Store the password in your secrets manager.

For a tighter scope (e.g. read-only, articles only), drop `administer nodes` / `administer taxonomy` and grant only `'view article'` / `'create article content'` etc.

## Install (Claude Code plugin)

```
/plugin marketplace add lucaspretti/claude-plugins
/plugin install drupal-mcp@lucaspretti-plugins
```

Set these env vars (via shell, `.env`, or your secrets manager):

```
DRUPAL_BASE_URL=https://your-site.example.com
DRUPAL_USER=mcp_bot
DRUPAL_PASSWORD=••••••••
```

## Install (standalone)

```bash
git clone https://github.com/lucaspretti/drupal-mcp.git
cd drupal-mcp
npm install
cp .env.example .env  # fill in
node drupal-mcp.js
```

In your MCP client config (Claude Desktop `claude_desktop_config.json`, Cline, etc.):

```json
{
  "mcpServers": {
    "drupal": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-mcp/drupal-mcp.js"],
      "env": {
        "DRUPAL_BASE_URL": "https://your-site.example.com",
        "DRUPAL_USER": "mcp_bot",
        "DRUPAL_PASSWORD": "••••••••"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `drupal_list_nodes` | List nodes of a bundle, with filter / sort / paginate |
| `drupal_get_node` | Fetch one node by UUID |
| `drupal_create_node` | Create a node (POST) |
| `drupal_update_node` | Patch attributes / relationships |
| `drupal_delete_node` | Delete by UUID (irreversible) |
| `drupal_list_taxonomy_terms` | List terms in a vocabulary |
| `drupal_list_users` | List users |
| `drupal_query_jsonapi` | Arbitrary GET against `/jsonapi/*` (escape hatch) |

Filter shorthand: `{ field_category: '<uuid>' }` → `filter[field_category]=<uuid>`. Use `{ field: { value, operator } }` for non-equality operators.

## CLI flags

Each env var has an equivalent flag, useful when running outside an `.env`-aware shell:

```
node drupal-mcp.js \
  --base-url=https://your-site.example.com \
  --user=mcp_bot \
  --password=•••• \
  --jsonapi-prefix=/jsonapi \
  --timeout=30000
```

`node drupal-mcp.js --help` for the full list.

## Troubleshooting

### `Error: fetch failed (cause: getaddrinfo ENOTFOUND <host>${var_name})`

Claude Code's `${VAR}` interpolation in `.mcp.json` substitutes from `process.env`, not from the `settings.json` env block alone. When a referenced var is unset upstream, the literal string `${var_name}` is passed to the spawned process and concatenated into the URL.

Fix: ensure every var in `.mcp.json` env is also set in `~/.claude/settings.json` (`env` block) or your shell environment. Or remove optional vars from `.mcp.json` and rely on the script's defaults.

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...zod-to-json-schema/dist/esm/index.js'`

The `@modelcontextprotocol/sdk` postinstall race occasionally leaves `zod-to-json-schema` half-built. Reinstall:

```bash
cd ~/.claude/plugins/cache/<marketplace>/drupal-mcp/<version>
rm -rf node_modules package-lock.json && npm install
```

### `401 Unauthorized` on every request

- The `basic_auth` core module is not enabled. `drush en basic_auth -y`.
- Or the password is wrong / the user is blocked.

### `403 Forbidden` on a specific bundle

The bot role lacks the permission for that bundle. Grant `'create <bundle> content'`, `'edit any <bundle> content'`, etc.

### `405 Method Not Allowed` on writes

`jsonapi.settings.read_only` is still `true`. See "JSON:API writes" above.

### `301` redirects to a language-prefixed URL

If the `language` module is enabled, `/jsonapi/...` redirects to `/<langcode>/jsonapi/...`. Node's `fetch` follows automatically; `curl` needs `-L`. Nothing to fix on the server side.

## Authentication

The plugin currently uses **HTTP Basic auth** (`basic_auth` core module). This is the simplest path that works out of the box on any Drupal site.

For a small / single-tenant deployment with a dedicated bot user and HTTPS-only, Basic auth is acceptable. For production or multi-integration setups, **OAuth2 via [`simple_oauth`](https://www.drupal.org/project/simple_oauth)** is the correct choice for service accounts:

|  | Basic auth (current) | OAuth2 client_credentials (roadmap) |
|---|---|---|
| Drupal module | `basic_auth` (core) | `simple_oauth` (contrib) |
| Wire format | `Authorization: Basic <base64(user:pass)>` on every request | `Authorization: Bearer <token>`, token cached + refreshed |
| Revocation | Change user password (affects UI login too) | Revoke token / consumer atomically |
| Scopes | None (role permissions only) | Per-token scopes |
| Setup | Enable module, create user | Install module, generate RSA keys, create consumer |

OAuth2 support is planned as an opt-in mode (`DRUPAL_AUTH_MODE=oauth` + `DRUPAL_OAUTH_CLIENT_ID` / `_SECRET` / `_TOKEN_URL`). Until then, treat the bot password as you would any service-account credential: store it in a secrets manager, scope the role tightly, and rotate periodically.

## Security notes

- HTTPS only. Basic auth means the bot password travels on every request — don't run against `http://`.
- The Drupal-side bot user's role is the security boundary. Keep it scoped to the bundles and operations you actually need.
- JSON:API respects field access, but not entity-access-bypass — be careful with admin-bypass perms on the bot role.
- `.env` is gitignored. Don't commit credentials.

## License

MIT
