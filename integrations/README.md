# Integrations

| Channel | Run | Notes |
| --- | --- | --- |
| MCP server | `npm run mcp` | stdio; tools `search_availability`, `create_booking`, `explain_decision`. Claude Desktop config below. |
| Telegram | `TELEGRAM_BOT_TOKEN=… npm run bot` | grammY long-polling. |
| WhatsApp | `POST /api/whatsapp` (webhook) | Set `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`. |
| OR-Tools solver | `cd solver && pip install -r requirements.txt && uvicorn main:app --port 8080` | Set `SOLVER_URL=http://localhost:8080` for the web app. |

Each headless channel holds its own seeded engine in memory until the Supabase backend is wired, so bookings made there do not show up in the browser demo.

```json
{ "mcpServers": { "xie-spaces": { "command": "npx", "args": ["tsx", "integrations/mcp-server.ts"], "cwd": "/path/to/b2b" } } }
```
