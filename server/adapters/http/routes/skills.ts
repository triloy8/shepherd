import {
  validateSkillsConfigWriteRequest,
  validateSkillsListRequest,
  validateSkillsRemoteExportRequest,
  validateSkillsRemoteListRequest,
} from "../../../../shared/protocol/validation.js";
import type { ConversationService } from "../../../core/conversation_service.js";
import { parseJsonBody, respondError, respondJson } from "./utils.js";

function mapRemoteSkillsError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if ((lower.includes("hazelnuts") && lower.includes("403")) || lower.includes("notallowed")) {
    return {
      status: 403,
      message: "Remote skills are not enabled for this account (Hazelnut access denied).",
    };
  }
  return { status: 400, message };
}

function parseQuery(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key in result) {
      const current = result[key];
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        result[key] = [current, value];
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

function readThreadIdFromQuery(url: URL): string {
  const threadId = url.searchParams.get("threadId")?.trim();
  if (!threadId) {
    throw new Error("Missing threadId query parameter.");
  }
  return threadId;
}

function readThreadIdFromBody(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid request payload.");
  }
  const threadId = (value as Record<string, unknown>).threadId;
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new Error("Missing threadId.");
  }
  return threadId.trim();
}

export async function handleListSkills(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const url = new URL(request.url);
    const threadId = readThreadIdFromQuery(url);
    const payload = validateSkillsListRequest(parseQuery(url));
    const result = await conversation.listSkills(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list skills.");
  }
}

export async function handleListRemoteSkills(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const url = new URL(request.url);
    const threadId = readThreadIdFromQuery(url);
    const payload = validateSkillsRemoteListRequest(parseQuery(url));
    const result = await conversation.listRemoteSkills(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    const mapped = mapRemoteSkillsError(error);
    return respondError(mapped.status, mapped.message || "Failed to list remote skills.");
  }
}

export async function handleExportRemoteSkill(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const body = await parseJsonBody(request);
    const threadId = readThreadIdFromBody(body);
    const payload = validateSkillsRemoteExportRequest(body);
    const result = await conversation.exportRemoteSkill(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    const mapped = mapRemoteSkillsError(error);
    return respondError(mapped.status, mapped.message || "Failed to export remote skill.");
  }
}

export async function handleWriteSkillConfig(request: Request, conversation: ConversationService): Promise<Response> {
  try {
    const body = await parseJsonBody(request);
    const threadId = readThreadIdFromBody(body);
    const payload = validateSkillsConfigWriteRequest(body);
    const result = await conversation.writeSkillConfig(threadId, payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to update skill config.");
  }
}
