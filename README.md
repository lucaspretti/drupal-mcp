# drupal-mcp

MCP server for Drupal sites via the core JSON:API. List, search, create, update, and delete nodes / taxonomy terms / users on any Drupal 10/11 site with the `jsonapi` module enabled.

Works two ways:

- **Claude Code plugin** — install via the `lucaspretti-plugins` marketplace and Claude prompts you for the env vars.
- **Standalone MCP** — `node drupal-mcp.js` with env vars set. Plug into Claude Desktop, Cline, or any other MCP-compatible client.

## Why JSON:API and not the older Drupal MCP module?

The contrib `drupal/mcp` module currently has ~250 installs and is in flux ("merging with the MCP Server module"). JSON:API is in Drupal core, stable, and standard. This server is a thin wrapper around endpoints your site already exposes — no new module to maintain on the Drupal side.

## Drupal-side setup (one-time)

1. Make sure the **JSON:API** module is enabled (`drush en jsonapi -y`). Core module, ships with Drupal.
2. Create a dedicated bot user with the minimum permissions you want to expose. Suggested:
   - Create role `mcp_bot`.
   - Grant only the bundles + operations you need (Article: View / Edit / Delete / Create, etc.). No admin perms.
   - Create user `mcp_bot` with that role and a strong password (store it in your password manager).
3. Optionally tighten JSON:API write access. By default it reads everything; writes are disabled unless you flip `jsonapi.settings:read_only = false` (set via Drush, `drush config:set jsonapi.settings read_only false -y`). Keep `read_only = true` if you only want list / read operations.

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

## Security notes

- HTTPS only. The server sends Basic auth on every request — don't run against `http://`.
- The Drupal-side bot user's role is the security boundary. Keep it scoped.
- JSON:API respects field access, but not entity access bypass — be careful with admin-bypass perms on the bot role.
- `.env` is gitignored. Don't commit credentials.

## License

MIT
