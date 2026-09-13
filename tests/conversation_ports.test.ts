import { expect, test } from "bun:test";
import { ConversationService } from "../server/core/conversation_service.js";
import { createApplicationConversation } from "../server/core/conversation_ports.js";

class TestConversation extends ConversationService {
  readonly marker = "bound-model";
  override getThreadModel(threadId: string) {
    return { threadId, currentModel: this.marker, pendingModel: null, modelProvider: "openai" };
  }
}

test("application capability object preserves receivers without exposing runtime controls", () => {
  const source = new TestConversation();
  const port = createApplicationConversation(source);
  expect(port).not.toBe(source);
  const getModel = port.getThreadModel;
  expect(getModel("thread-1").currentModel).toBe("bound-model");
  for (const method of ["stopAll", "registerDynamicTool", "createSurfaceThread", "bindSurfaceToThread", "submitTurn"]) {
    expect(method in port).toBe(false);
  }
});
