/** The binary build replaces this module with an embedded SDK executable. */
export function claudeExecutablePath(): string | undefined {
  return process.env.CLAUDE_EXECUTABLE;
}
