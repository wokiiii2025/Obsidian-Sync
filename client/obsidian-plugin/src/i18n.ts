import type { Language } from "./types";

type TranslationKey =
  | "command.syncNow"
  | "command.lock"
  | "notice.locked"
  | "notice.unlocked"
  | "notice.syncFailed"
  | "notice.unlockFirst"
  | "notice.syncComplete"
  | "notice.syncCompleteStats"
  | "notice.conflicts"
  | "notice.registered"
  | "notice.loggedIn"
  | "notice.prefix"
  | "error.vaultIdRequired"
  | "error.passwordRequired"
  | "settings.language.name"
  | "settings.language.desc"
  | "settings.language.en"
  | "settings.language.zh"
  | "settings.serverUrl.name"
  | "settings.serverUrl.desc"
  | "settings.vaultId.name"
  | "settings.vaultId.desc"
  | "settings.password.name"
  | "settings.password.desc"
  | "settings.password.placeholder"
  | "settings.register.name"
  | "settings.register.desc"
  | "settings.register.button"
  | "settings.login.name"
  | "settings.login.desc"
  | "settings.login.button"
  | "settings.unlock.name"
  | "settings.unlock.desc"
  | "settings.unlock.button"
  | "settings.syncMode.name"
  | "settings.syncMode.manual"
  | "settings.syncMode.periodic"
  | "settings.interval.name"
  | "settings.interval.desc"
  | "settings.autoSync.name"
  | "settings.autoSync.desc"
  | "settings.autoSyncDebounce.name"
  | "settings.autoSyncDebounce.desc"
  | "settings.exclusions.name"
  | "settings.exclusions.desc"
  | "settings.manual.name"
  | "settings.manual.desc"
  | "settings.manual.never"
  | "settings.manual.button"
  | "settings.status.name"
  | "settings.status.desc"
  | "settings.status.idle"
  | "settings.status.running"
  | "settings.status.success"
  | "settings.status.error"
  | "settings.status.locked"
  | "settings.stats.tracked"
  | "settings.stats.uploaded"
  | "settings.stats.downloaded"
  | "settings.stats.conflicts"
  | "settings.stats.started"
  | "settings.stats.finished"
  | "settings.stats.error"
  | "settings.stats.none"
  | "statusbar.aria"
  | "statusbar.tooltip"
  | "statusbar.short"
  | "notice.autoSyncQueued";

const translations: Record<Language, Record<TranslationKey, string>> = {
  en: {
    "command.syncNow": "Sync now",
    "command.lock": "Lock sync password",
    "notice.locked": "Zero Knowledge Sync locked.",
    "notice.unlocked": "Zero Knowledge Sync unlocked.",
    "notice.syncFailed": "Zero Knowledge Sync failed: {message}",
    "notice.unlockFirst": "Zero Knowledge Sync: unlock the vault password first.",
    "notice.syncComplete": "Zero Knowledge Sync complete.",
    "notice.syncCompleteStats": "Sync complete. Uploaded {uploaded}, downloaded {downloaded}, conflicts {conflicts}.",
    "notice.conflicts": "Zero Knowledge Sync: {count} conflict copy created.",
    "notice.registered": "Zero Knowledge Sync registered.",
    "notice.loggedIn": "Zero Knowledge Sync logged in.",
    "notice.prefix": "Zero Knowledge Sync: {message}",
    "error.vaultIdRequired": "Vault ID is required",
    "error.passwordRequired": "Password is required",
    "settings.language.name": "Language",
    "settings.language.desc": "Choose the display language for this plugin.",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.serverUrl.name": "Server URL",
    "settings.serverUrl.desc": "Sync API base URL.",
    "settings.vaultId.name": "Vault ID",
    "settings.vaultId.desc": "Filled after registration. Keep this to log in on another device.",
    "settings.password.name": "Vault password",
    "settings.password.desc": "Used locally for encryption and server login.",
    "settings.password.placeholder": "Password",
    "settings.register.name": "Register this vault",
    "settings.register.desc": "Creates a new server vault and stores the returned token.",
    "settings.register.button": "Register",
    "settings.login.name": "Login this device",
    "settings.login.desc": "Use an existing vault ID and password to register this device.",
    "settings.login.button": "Login",
    "settings.unlock.name": "Unlock encryption",
    "settings.unlock.desc": "Derives the local encryption key for this Obsidian session.",
    "settings.unlock.button": "Unlock",
    "settings.syncMode.name": "Sync mode",
    "settings.syncMode.manual": "Manual only",
    "settings.syncMode.periodic": "Periodic",
    "settings.interval.name": "Sync interval",
    "settings.interval.desc": "Seconds. Used only in periodic mode.",
    "settings.autoSync.name": "Sync on file changes",
    "settings.autoSync.desc": "Automatically sync after Markdown files are created, edited, renamed, or deleted.",
    "settings.autoSyncDebounce.name": "File-change delay",
    "settings.autoSyncDebounce.desc": "Seconds to wait after the last file change before syncing.",
    "settings.exclusions.name": "Exclusions",
    "settings.exclusions.desc": "One path or simple folder pattern per line.",
    "settings.manual.name": "Manual sync",
    "settings.manual.desc": "Last sync: {time}",
    "settings.manual.never": "never",
    "settings.manual.button": "Sync now",
    "settings.status.name": "Sync status",
    "settings.status.desc": "{status}",
    "settings.status.idle": "Idle",
    "settings.status.running": "Running",
    "settings.status.success": "Success",
    "settings.status.error": "Error",
    "settings.status.locked": "Locked",
    "settings.stats.tracked": "Tracked notes: {count}",
    "settings.stats.uploaded": "Uploaded last run: {count}",
    "settings.stats.downloaded": "Downloaded last run: {count}",
    "settings.stats.conflicts": "Conflicts last run: {count}",
    "settings.stats.started": "Last started: {time}",
    "settings.stats.finished": "Last finished: {time}",
    "settings.stats.error": "Last error: {message}",
    "settings.stats.none": "none",
    "statusbar.aria": "Zero Knowledge Sync",
    "statusbar.tooltip": "{status}. Tracked {tracked}. Uploaded {uploaded}, downloaded {downloaded}, conflicts {conflicts}.",
    "statusbar.short": "{tracked}",
    "notice.autoSyncQueued": "Sync queued after file changes."
  },
  zh: {
    "command.syncNow": "立即同步",
    "command.lock": "锁定同步密码",
    "notice.locked": "Zero Knowledge Sync 已锁定。",
    "notice.unlocked": "Zero Knowledge Sync 已解锁。",
    "notice.syncFailed": "Zero Knowledge Sync 同步失败：{message}",
    "notice.unlockFirst": "Zero Knowledge Sync：请先解锁 Vault 密码。",
    "notice.syncComplete": "Zero Knowledge Sync 同步完成。",
    "notice.syncCompleteStats": "同步完成。上传 {uploaded}，下载 {downloaded}，冲突 {conflicts}。",
    "notice.conflicts": "Zero Knowledge Sync：已创建 {count} 个冲突副本。",
    "notice.registered": "Zero Knowledge Sync 注册成功。",
    "notice.loggedIn": "Zero Knowledge Sync 登录成功。",
    "notice.prefix": "Zero Knowledge Sync：{message}",
    "error.vaultIdRequired": "需要填写 Vault ID",
    "error.passwordRequired": "需要填写密码",
    "settings.language.name": "语言",
    "settings.language.desc": "选择插件界面显示语言。",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.serverUrl.name": "服务器地址",
    "settings.serverUrl.desc": "Sync API 的基础地址。",
    "settings.vaultId.name": "Vault ID",
    "settings.vaultId.desc": "注册后自动填入；其他设备登录时需要保留这个 ID。",
    "settings.password.name": "Vault 密码",
    "settings.password.desc": "用于本地加密和服务端登录。",
    "settings.password.placeholder": "密码",
    "settings.register.name": "注册当前 Vault",
    "settings.register.desc": "在服务器创建新的 Vault，并保存返回的令牌。",
    "settings.register.button": "注册",
    "settings.login.name": "登录当前设备",
    "settings.login.desc": "使用已有 Vault ID 和密码把当前设备加入同步。",
    "settings.login.button": "登录",
    "settings.unlock.name": "解锁加密",
    "settings.unlock.desc": "为当前 Obsidian 会话派生本地加密密钥。",
    "settings.unlock.button": "解锁",
    "settings.syncMode.name": "同步模式",
    "settings.syncMode.manual": "仅手动",
    "settings.syncMode.periodic": "定时同步",
    "settings.interval.name": "同步间隔",
    "settings.interval.desc": "单位为秒，仅在定时同步模式下生效。",
    "settings.autoSync.name": "文件变化后自动同步",
    "settings.autoSync.desc": "Markdown 文件新建、编辑、重命名或删除后自动同步。",
    "settings.autoSyncDebounce.name": "文件变化延迟",
    "settings.autoSyncDebounce.desc": "最后一次文件变化后等待多少秒再同步。",
    "settings.exclusions.name": "排除规则",
    "settings.exclusions.desc": "每行一个路径或简单文件夹模式。",
    "settings.manual.name": "手动同步",
    "settings.manual.desc": "上次同步：{time}",
    "settings.manual.never": "从未",
    "settings.manual.button": "立即同步",
    "settings.status.name": "同步状态",
    "settings.status.desc": "{status}",
    "settings.status.idle": "空闲",
    "settings.status.running": "同步中",
    "settings.status.success": "成功",
    "settings.status.error": "失败",
    "settings.status.locked": "未解锁",
    "settings.stats.tracked": "已跟踪笔记：{count}",
    "settings.stats.uploaded": "上次上传：{count}",
    "settings.stats.downloaded": "上次下载：{count}",
    "settings.stats.conflicts": "上次冲突：{count}",
    "settings.stats.started": "上次开始：{time}",
    "settings.stats.finished": "上次结束：{time}",
    "settings.stats.error": "最近错误：{message}",
    "settings.stats.none": "无",
    "statusbar.aria": "Zero Knowledge Sync",
    "statusbar.tooltip": "{status}。已跟踪 {tracked}。上传 {uploaded}，下载 {downloaded}，冲突 {conflicts}。",
    "statusbar.short": "{tracked}",
    "notice.autoSyncQueued": "已在文件变化后加入同步队列。"
  }
};

export function t(language: Language, key: TranslationKey, replacements: Record<string, string | number> = {}): string {
  let value = translations[language]?.[key] ?? translations.en[key];
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}
