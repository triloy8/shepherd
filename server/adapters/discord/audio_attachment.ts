export type DiscordAudioAttachment = {
  contentType?: string | null;
  name?: string | null;
};

const AUDIO_EXTENSIONS = [".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav", ".webm"];

export function isDiscordAudioAttachment(attachment: DiscordAudioAttachment): boolean {
  const contentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType.startsWith("video/")) return false;
  if (contentType.startsWith("audio/")) return true;

  const name = attachment.name?.trim().toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension));
}
