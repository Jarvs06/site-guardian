import type Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { ChatRequest, USER_REF_HEADER, type ChatResponse } from "@sg/shared";
import type { AppDeps } from "../app.js";
import { ApiError } from "../lib/errors.js";
import { buildSystemPrompt } from "../lib/prompts.js";
import { limiter } from "../lib/rate-limit.js";
import { requireSite, siteOf } from "../middleware/site-auth.js";

const HISTORY_LIMIT = 20;

/** POST /ai/chat: server-held conversation history; the client sends only message + conversation_id. */
export function chatRouter(deps: AppDeps): Router {
  const { pool, ai } = deps;
  const r = Router();
  r.post(
    "/ai/chat",
    requireSite(deps),
    (req, _res, next) => {
      next(req.wpUserRef ? undefined : ApiError.badRequest(`Missing ${USER_REF_HEADER} header.`));
    },
    limiter(pool, "ai-chat", { points: 20, durationSec: 60 }, (req) => `${siteOf(req).id}:${req.wpUserRef ?? ""}`),
    async (req, res, next) => {
      try {
        const parsed = ChatRequest.safeParse(req.body);
        if (!parsed.success) throw ApiError.badRequest("Invalid chat request.");
        const { message, conversation_id } = parsed.data;
        const site = siteOf(req);
        const userRef = req.wpUserRef!;

        // A supplied id is honoured only when it belongs to this website and user; otherwise start fresh.
        let conversationId: string | undefined;
        if (conversation_id) {
          const { rows } = await pool.query<{ id: string }>(
            "select id from ai_conversations where id = $1 and website_id = $2 and wp_user_ref = $3",
            [conversation_id, site.id, userRef],
          );
          conversationId = rows[0]?.id;
        }
        if (!conversationId) {
          const { rows } = await pool.query<{ id: string }>(
            "insert into ai_conversations (website_id, wp_user_ref) values ($1, $2) returning id",
            [site.id, userRef],
          );
          conversationId = rows[0]!.id;
        }

        const history = await pool.query<{ role: "user" | "assistant"; content: string }>(
          `select role, content from (
             select role, content, created_at from ai_messages
              where conversation_id = $1 and role in ('user','assistant')
              order by created_at desc limit $2
           ) t order by created_at asc`,
          [conversationId, HISTORY_LIMIT],
        );

        // Stored first so the user's message survives an AI failure.
        await pool.query("insert into ai_messages (conversation_id, role, content) values ($1, 'user', $2)", [
          conversationId,
          message,
        ]);

        const nameRow = await pool.query<{ site_name: string | null }>("select site_name from websites where id = $1", [site.id]);
        const system = buildSystemPrompt(nameRow.rows[0]?.site_name || site.origin, site.origin);
        const messages: Anthropic.MessageParam[] = [
          ...history.rows.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ];

        const reply = await ai.reply({ system, messages });

        await pool.query("insert into ai_messages (conversation_id, role, content) values ($1, 'assistant', $2)", [
          conversationId,
          reply,
        ]);
        await pool.query("update ai_conversations set updated_at = now() where id = $1", [conversationId]);

        const out: ChatResponse = { reply, conversation_id: conversationId };
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );
  return r;
}
