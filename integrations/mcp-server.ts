/**
 * XIE Spaces MCP server (stdio). Lets any MCP client (Claude Desktop, Claude Code, agents) book rooms
 * through the same engine and rules as the web app.
 *   npx tsx integrations/mcp-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BookingIntent } from "@/lib/intent";
import { create, explain, search } from "@/lib/server/host";
import { todayISO } from "@/lib/time";

const server = new McpServer({ name: "xie-spaces", version: "0.2.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.registerTool(
  "search_availability",
  {
    description: "Find free rooms at Xavier Institute of Engineering ranked by fit. Types: lh, lab, tutorial, seminar, study, meeting, outdoor.",
    inputSchema: {
      resource_type: BookingIntent.shape.resource_type,
      min_capacity: BookingIntent.shape.min_capacity,
      tags: z.array(z.string()).default([]),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayISO()),
      window: z.tuple([z.string(), z.string()]).default(["08:00", "20:00"]),
      duration_minutes: z.number().int().min(15).max(600).default(60),
      purpose: BookingIntent.shape.purpose.default("casual"),
    },
  },
  async (a) => json(search({ intent: "search", confidence: 1, clarifying_question: null, ...a })),
);

server.registerTool(
  "create_booking",
  {
    description: "Book a room. Goes through the rules gate, priority scoring and the double-booking guard. Returns status or alternatives.",
    inputSchema: {
      room_id: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      title: z.string().max(120),
      purpose: BookingIntent.shape.purpose,
      attendees: z.number().int().min(1),
      requester: z.string().default("MCP agent"),
      role: z.enum(["student", "faculty", "approver", "admin"]).default("student"),
    },
  },
  async (a) => json(create({ roomIds: [a.room_id], date: a.date, start: a.start, end: a.end, title: a.title, purpose: a.purpose, attendees: a.attendees, requester: a.requester, role: a.role })),
);

server.registerTool(
  "explain_decision",
  { description: "Explain why a booking was confirmed, bumped or rejected, with the score breakdown.", inputSchema: { booking_id: z.string() } },
  async ({ booking_id }) => json(explain(booking_id)),
);

server.connect(new StdioServerTransport()).catch((e) => {
  console.error(e);
  process.exit(1);
});
