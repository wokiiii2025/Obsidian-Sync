import type { PluginSettings } from "./types";

export type FileCategory = "markdown" | "data" | "images" | "documents" | "audio" | "video" | "archives" | "other";

export function fileCategory(extension: string): FileCategory {
  const ext = extension.toLowerCase();
  if (ext === "md") {
    return "markdown";
  }
  if (ext === "json") {
    return "data";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
    return "images";
  }
  if (["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt"].includes(ext)) {
    return "documents";
  }
  if (["mp3", "wav", "m4a", "flac", "ogg", "aac"].includes(ext)) {
    return "audio";
  }
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) {
    return "video";
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return "archives";
  }
  return "other";
}

export function isFileTypeSyncEnabled(extension: string, settings: PluginSettings): boolean {
  switch (fileCategory(extension)) {
    case "markdown":
      return settings.syncMarkdown;
    case "data":
      return settings.syncJson;
    case "images":
      return settings.syncImages;
    case "documents":
      return settings.syncDocuments;
    case "audio":
      return settings.syncAudio;
    case "video":
      return settings.syncVideo;
    case "archives":
      return settings.syncArchives;
    default:
      return settings.syncOtherFiles;
  }
}

export function isManagedAttachmentExtension(extension: string): boolean {
  const category = fileCategory(extension);
  return !["markdown", "data"].includes(category);
}
