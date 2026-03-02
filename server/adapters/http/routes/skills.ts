import {
  validateSkillsConfigWriteRequest,
  validateSkillsListRequest,
  validateSkillsRemoteExportRequest,
  validateSkillsRemoteListRequest,
} from "../../../../shared/protocol/validation.js";
import type { SessionManager } from "../../../core/session_manager.js";
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

export async function handleListSkills(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateSkillsListRequest(parseQuery(new URL(request.url)));
    const result = await manager.listSkills(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to list skills.");
  }
}

export async function handleListRemoteSkills(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateSkillsRemoteListRequest(parseQuery(new URL(request.url)));
    const result = await manager.listRemoteSkills(payload);
    return respondJson(200, result);
  } catch (error) {
    const mapped = mapRemoteSkillsError(error);
    return respondError(mapped.status, mapped.message || "Failed to list remote skills.");
  }
}

export async function handleExportRemoteSkill(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateSkillsRemoteExportRequest(await parseJsonBody(request));
    const result = await manager.exportRemoteSkill(payload);
    return respondJson(200, result);
  } catch (error) {
    const mapped = mapRemoteSkillsError(error);
    return respondError(mapped.status, mapped.message || "Failed to export remote skill.");
  }
}

export async function handleWriteSkillConfig(request: Request, manager: SessionManager): Promise<Response> {
  try {
    const payload = validateSkillsConfigWriteRequest(await parseJsonBody(request));
    const result = await manager.writeSkillConfig(payload);
    return respondJson(200, result);
  } catch (error) {
    return respondError(400, error instanceof Error ? error.message : "Failed to update skill config.");
  }
}
