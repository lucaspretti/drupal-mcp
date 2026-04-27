---
name: drupal-api
description: Read and write content on a Drupal site through its core JSON:API. Use this skill whenever the user asks to list, search, create, update, or delete Drupal nodes (articles, pages, custom content types), browse taxonomy terms, or list users on a Drupal site that has the drupal-mcp plugin configured. Trigger on phrases like "edit this article", "publish a new page", "what's the latest blog post", "delete this node", "list all articles in category X", or any direct mention of Drupal content. The plugin connects via HTTP Basic auth using DRUPAL_BASE_URL / DRUPAL_USER / DRUPAL_PASSWORD environment variables.
---

# Drupal MCP

This plugin exposes a Drupal site's core JSON:API as MCP tools. It works on any Drupal 10/11 site with the `jsonapi` core module enabled.

## Tools

- `drupal_list_nodes` — list nodes of a bundle (filter / sort / paginate).
- `drupal_get_node` — fetch one node by UUID.
- `drupal_create_node` — create a new node.
- `drupal_update_node` — patch attributes or relationships.
- `drupal_delete_node` — delete by UUID.
- `drupal_list_taxonomy_terms` — list terms in a vocabulary.
- `drupal_list_users` — list users.
- `drupal_query_jsonapi` — escape hatch for arbitrary GETs.

## Conventions

- All identifiers are UUIDs (JSON:API canonical), not numeric `nid`s. Use `drupal_list_nodes` first to find the UUID.
- Bundle = content type machine name (e.g. `article`, `page`).
- `attributes` is a flat object of JSON:API field names → values, e.g. `{ title: '...', body: { value: '...', format: 'basic_html' }, status: true }`.
- `relationships` follow JSON:API shape: `{ field_image: { data: { type: 'file--file', id: 'uuid' } } }`.
- Filter shorthand: `{ field_category: '1' }` becomes `filter[field_category]=1`. Operators: `{ field_category: { value: '1', operator: '=' } }`.

## Auth + permissions

The MCP runs as a configured Drupal user. Permissions on that user's role decide what is reachable. For least privilege, create a `mcp_bot` user with a dedicated role that only grants the bundles/operations you actually need. JSON:API ignores the `access_check` flag — Drupal field access still applies.

## Pre-flight

Before any write, confirm with the user:
1. Which bundle / vocabulary?
2. Which environment (prod vs dev)?
3. Show the full payload before issuing the call.

Deletion is irreversible. Always read first, then ask, then delete.

## Common patterns

**Find the latest published articles:**
```
drupal_list_nodes(bundle='article', filter={status: 1}, sort='-created', limit=5)
```

**Update an article body:**
```
drupal_update_node(bundle='article', uuid='<uuid>', attributes={ body: { value: '...', format: 'basic_html' } })
```

**Lookup taxonomy term ID for filter chains:**
```
drupal_list_taxonomy_terms(vocabulary='category')
# then use the returned UUID in a node filter
```
