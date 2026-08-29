import { describe, expect, test } from "bun:test";

import { resolveShepherdConfigDir } from "../server/config/environment.js";

describe("resolveShepherdConfigDir", () => {
  test("defaults to the Shepherd checkout configuration", () => {
    expect(resolveShepherdConfigDir(undefined, "/srv/shepherd")).toBe(
      "/srv/shepherd/.codex",
    );
  });

  test("resolves a configured relative directory from the Shepherd checkout", () => {
    expect(resolveShepherdConfigDir("config/codex", "/srv/shepherd")).toBe(
      "/srv/shepherd/config/codex",
    );
  });

  test("preserves an absolute configuration directory", () => {
    expect(resolveShepherdConfigDir("/run/shepherd/codex", "/srv/shepherd")).toBe(
      "/run/shepherd/codex",
    );
  });
});
