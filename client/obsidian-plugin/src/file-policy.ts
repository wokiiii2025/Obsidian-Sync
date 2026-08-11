import type { PluginSettings } from "./types";
import { PROTECTED_EXCLUSIONS } from "./defaults";

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

export function isPathSyncEnabled(path: string, extension: string, settings: PluginSettings): boolean {
  if (isProtectedPluginPath(path)) {
    return false;
  }
  if (isPluginDirectoryPath(path)) {
    return settings.syncPluginDirectories && !isExcludedPluginDirectoryPath(path, settings.excludedPluginDirectories);
  }
  if (path === ".obsidian" || path.startsWith(".obsidian/")) {
    return settings.syncObsidianConfig;
  }
  return isFileTypeSyncEnabled(extension, settings);
}

export function isPluginDirectoryPath(path: string): boolean {
  return path.toLowerCase().startsWith(".obsidian/plugins/");
}

export function isPathExcluded(path: string, exclusions: string): boolean {
  if (isAppleDoublePath(path)) {
    return true;
  }
  if (isSystemNoisePath(path)) {
    return true;
  }
  if (isProtectedPluginPath(path)) {
    return true;
  }
  if (isSyncStatePath(path)) {
    return true;
  }
  const patterns = [...PROTECTED_EXCLUSIONS, ...exclusions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)];
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return path.startsWith(pattern.slice(0, -3));
    }
    if (pattern === "._*" || pattern === "**/._*") {
      return isAppleDoublePath(path);
    }
    return path === pattern || path.startsWith(`${pattern}/`);
  });
}

export function isManagedAttachmentExtension(extension: string): boolean {
  const category = fileCategory(extension);
  return !["markdown", "data"].includes(category);
}

function isAppleDoublePath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("._"));
}

function isSystemNoisePath(path: string): boolean {
  return path.split("/").some((part) => part === ".DS_Store");
}

function isProtectedPluginPath(path: string): boolean {
  return path.toLowerCase().startsWith(".obsidian/plugins/obsidian-zero-knowledge-sync/");
}

function isSyncStatePath(path: string): boolean {
  return path === ".obsidian/zero-knowledge-sync-state.json" || path.startsWith(".obsidian/zero-knowledge-sync-state.json.");
}

function isExcludedPluginDirectoryPath(path: string, excludedPluginDirectories: string): boolean {
  const pluginId = pluginIdFromPath(path);
  if (!pluginId || pluginId === "obsidian-zero-knowledge-sync") {
    return true;
  }
  return parsePluginDirectoryList(excludedPluginDirectories).has(pluginId);
}

function pluginIdFromPath(path: string): string {
  const parts = path.split("/");
  if (parts.length < 4 || parts[0] !== ".obsidian" || parts[1] !== "plugins") {
    return "";
  }
  return parts[2].trim().toLowerCase();
}

function parsePluginDirectoryList(pluginDirectories: string): Set<string> {
  return new Set(
    pluginDirectories
      .split(/\r?\n|,/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean)
      .filter((pluginId) => pluginId !== "obsidian-zero-knowledge-sync")
  );
}
