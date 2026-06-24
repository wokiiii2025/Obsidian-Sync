# Obsidian 云同步 + Telegram 知识采集 需求文档

> 版本: v1.0 | 日期: 2026-06-24 | 状态: 设计阶段

---

## 一、项目概述

### 1.1 目标

实现两大核心能力：

1. **Obsidian 云同步** — 自研插件，支持跨平台（macOS / iOS / Android）多端实时同步，内容端到端加密存储于 PostgreSQL
2. **Telegram 知识采集** — 私密频道 Bot 接收消息（链接、视频、文字），经 Hermes Agent 智能处理后合并到 Obsidian 知识库，合并完成自动清理频道消息

### 1.2 核心设计原则

- **E2E 加密** — 服务端零知识，永远不解密用户内容
- **内容合并而非追加** — 新内容智能合并到已有笔记，而非每次新建 `.md` 文件
- **容器化部署** — Docker Compose 一键启动，不依赖特定云平台
- **现代技术栈** — FastAPI + PostgreSQL + TypeScript + esbuild
- **每个笔记独立 DEK** — 改密码无需重加密全库

---

## 二、总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    Telegram 私密频道 (≤5人)                        │
│             发链接/视频/文字 → @KnowledgeBot                       │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Webhook
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Hermes Agent                                │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│  │ 主Agent  │──▶│ Explorer │──▶│  Writer  │──▶│ 合并写入  │      │
│  │ 分析路由  │   │ 搜索提取  │   │ 格式化   │   │ Vault    │      │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘      │
└────────────────────────┬─────────────────────────────────────────┘
                         │ REST API
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Sync Server (Docker)                          │
│  ┌──────────────────┐        ┌──────────────────┐                │
│  │   FastAPI         │◀─────▶│  PostgreSQL 15   │                │
│  │   Sync REST API   │        │  (加密内容存储)   │                │
│  └──────────────────┘        └──────────────────┘                │
└─────────────────┬───────────────────────┬────────────────────────┘
                  │                       │
          ┌───────▼───────┐       ┌───────▼───────┐
          │  macOS        │       │  iOS / Android │
          │  Obsidian+插件 │       │  Obsidian+插件  │
          └───────────────┘       └───────────────┘
```

### 2.1 组件说明

| 组件 | 职责 | 技术 |
|------|------|------|
| **Sync Server** | 加密内容存储、同步协议、设备管理 | FastAPI + PostgreSQL 15 |
| **Obsidian Plugin** | 本地加解密、双向同步、冲突处理 | TypeScript + esbuild |
| **Hermes Agent** | 内容分析、子 Agent 调度、合并写入 | 现有 Hermes 框架 |
| **Telegram Bot** | 接收频道消息、转发到 Hermes | 现有 Hermes Telegram 集成 |

---

## 三、加密设计

### 3.1 双层密钥架构

```
用户密码 (User Password)
       │ Argon2id (memory=64MB, iterations=3, parallelism=4)
       ▼
  KEK (Key Encryption Key)    ← 256-bit，存储在本地 OS Keychain
       │
       │ AES-256-GCM 加密
       ▼
  ┌────────────────────────────────────┐
  │  DEK₁    DEK₂    DEK₃    ...       │  ← 每笔记一个，随机生成 (256-bit)
  │  (note1) (note2) (note3)           │
  └────────────────────────────────────┘
       │          │          │
       ▼          ▼          ▼
  AES-256-GCM 加密笔记内容 + 路径
```

### 3.2 设计决策

| 决策 | 理由 |
|------|------|
| **双层密钥 (KEK + DEK)** | 改密码只重加密 DEK，无需重加密所有笔记 |
| **Argon2id** | 抗 GPU/ASIC 暴力破解，OWASP 推荐 |
| **每个笔记独立 DEK** | 单笔记泄露不影响其他笔记，降低攻击面 |
| **DEK 随机生成 (crypto.randomBytes)** | 每个笔记密钥不可预测 |
| **OS Keychain 缓存 KEK** | macOS Keychain / Windows Credential Manager / Linux libsecret；解锁一次后免重复输入 |
| **服务器零知识** | 只存储 `encrypted_dek` + `encrypted_content`；解密仅在客户端发生 |

### 3.3 加密内容格式

```
加密载荷 (bytes):
┌──────────┬───────────────┬─────────────────────┐
│ Nonce    │ Ciphertext    │ Auth Tag            │
│ 12 bytes │ variable      │ 16 bytes            │
└──────────┴───────────────┴─────────────────────┘

加密算法: AES-256-GCM
Nonce: crypto.randomBytes(12)，每次加密重新生成
关联数据 (AAD): note_path_hash (防篡改)
```

---

## 四、Sync Server 设计

### 4.1 数据库 Schema

```sql
-- ============================================================
-- Vaults: 每个用户一个 Vault
-- ============================================================
CREATE TABLE vaults (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Devices: 每个设备注册记录
-- ============================================================
CREATE TABLE devices (
    id           UUID PRIMARY KEY,
    vault_id     UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    device_name  TEXT,
    platform     TEXT,  -- 'macos', 'ios', 'android', 'hermes'
    last_seen    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Notes: 核心笔记表（加密存储）
-- ============================================================
CREATE TABLE notes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id          UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    path_hash         TEXT NOT NULL,        -- SHA256(明文路径)，用于索引和查重
    path_encrypted    BYTEA NOT NULL,        -- AES-256-GCM(path)
    content_encrypted BYTEA NOT NULL,        -- AES-256-GCM(content)
    dek_encrypted     BYTEA NOT NULL,        -- KEK(DEK)，每个笔记独立的加密密钥
    version_vector    JSONB NOT NULL DEFAULT '{}',  -- {device_id: counter}
    file_size         INT,
    mime_type         TEXT DEFAULT 'text/markdown',
    modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,           -- 软删除标记
    UNIQUE(vault_id, path_hash)              -- 同一 vault 内路径唯一
);

CREATE INDEX idx_notes_vault_modified ON notes(vault_id, modified_at);
CREATE INDEX idx_notes_vault_path ON notes(vault_id, path_hash);

-- ============================================================
-- Sync Log: 增量同步变更日志
-- ============================================================
CREATE TABLE sync_log (
    id              BIGSERIAL PRIMARY KEY,
    vault_id        UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    note_id         UUID REFERENCES notes(id) ON DELETE SET NULL,
    device_id       UUID,
    operation       TEXT NOT NULL,           -- 'create' | 'update' | 'delete'
    path_hash       TEXT,
    version_vector  JSONB,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_log_vault_time ON sync_log(vault_id, synced_at);

-- ============================================================
-- Hermes Queue: Telegram 消息处理队列（非加密区）
-- ============================================================
CREATE TABLE hermes_queue (
    id              BIGSERIAL PRIMARY KEY,
    vault_id        UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    target_note_path TEXT,                  -- 目标笔记路径（明文，仅 Hermes 持有）
    merge_content   TEXT,                   -- 待合并内容（明文，仅 Hermes 持有）
    source_url      TEXT,                   -- 来源链接
    source_type     TEXT,                   -- 'youtube'|'article'|'tweet'|'video'|'text'|'url'
    status          TEXT DEFAULT 'pending', -- 'pending'|'merged'|'conflict'|'failed'
    error_message   TEXT,                   -- 失败原因
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at       TIMESTAMPTZ
);
```

### 4.2 API Endpoints

```
Base URL: https://<host>/api/v1

# === 认证 ===
POST   /auth/register         # 注册新 Vault
  Request:  { vault_name, password }
  Response: { vault_id, device_id, token }

POST   /auth/login            # 登录
  Request:  { vault_id, password }
  Response: { token }

# === 同步 ===
GET    /sync/changes          # 增量拉取变更
  Query:   ?since=<ISO_timestamp>&limit=100
  Headers: Authorization: Bearer <token>
  Response: { changes: [{ note_id, path_hash, encrypted_path, 
              encrypted_content, encrypted_dek, version_vector, 
              operation, modified_at }] }

POST   /sync/push             # 推送本地变更
  Headers: Authorization: Bearer <token>
  Request:  { changes: [{ path_hash, encrypted_path,
              encrypted_content, encrypted_dek, version_vector,
              operation }] }
  Response: { accepted: [...], conflicts: [...] }

POST   /sync/resolve          # 手动解决冲突
  Request:  { note_id, accepted_version_vector }

# === Hermes 专用 (API Key 认证) ===
POST   /hermes/read           # 读取笔记当前内容（用于合并前的上下文获取）
  Headers: X-API-Key: <hermes_api_key>
  Request:  { vault_id, note_path }
  Response: { content (解密后的明文), version_vector }

POST   /hermes/merge          # 合并内容到指定笔记
  Headers: X-API-Key: <hermes_api_key>
  Request:  { vault_id, note_path, merge_content, source_url, source_type }
  Response: { status, new_version_vector }

# === 健康检查 ===
GET    /health
```

### 4.3 同步协议

```
┌─────────┐                          ┌──────────┐
│ Client  │                          │  Server  │
└────┬────┘                          └────┬─────┘
     │  GET /sync/changes?since=t0        │
     │ ──────────────────────────────────▶│
     │  [{note_id, version_vector, ...}]  │
     │ ◀──────────────────────────────────│
     │                                    │
     │  本地应用变更 + 收集本地修改          │
     │                                    │
     │  POST /sync/push [changes]         │
     │ ──────────────────────────────────▶│
     │                                    │ 比较 version_vector
     │                                    │  ├── 无冲突: 直接更新
     │                                    │  └── 有冲突: 返回冲突列表
     │  {accepted, conflicts}             │
     │ ◀──────────────────────────────────│
```

**版本向量比较规则：**
- 向量 A ≥ 向量 B：A 包含 B 的所有修改 → A 胜出
- 向量不可比较：真正冲突 → 后推送者胜出 + 冲突副本返回

---

## 五、Obsidian 插件设计

### 5.1 技术栈

| 层 | 选型 |
|---|------|
| 框架 | Obsidian Plugin API |
| 语言 | TypeScript |
| 构建 | esbuild |
| 加密 | `@noble/ciphers` (AES-256-GCM) + `@noble/hashes` (Argon2id) |
| HTTP | 原生 `fetch` |
| Keychain | `keytar` (桌面) / 对应平台 SecureStore (移动) |

### 5.2 插件设置面板

```yaml
Server Configuration:
  Server URL:    [https://sync.example.com]
  Vault Password: [••••••••••••]

Sync Mode:
  ( ) Real-time (WebSocket)
  (•) Periodic (interval: 30s)
  ( ) Manual only

Conflict Resolution:
  (•) Auto — newer version wins, keep conflict copies
  ( ) Manual — ask each time

Exclusions:
  [.obsidian-syncignore 文件路径]
  [支持 glob pattern 排除文件/文件夹]

Statistics:
  已同步: 1,234 笔记
  上次同步: 2026-06-24 14:30:00
  待上传: 3  待下载: 0
```

### 5.3 同步流程

```
1. 启动/定时触发
   │
2. 拉取远端变更: GET /sync/changes?since=<last_sync>
   │
3. 对每个远端变更:
   ├── 解密 DEK (KEK → DEK)
   ├── 解密路径 (AES-GCM)
   ├── 解密内容
   ├── 比较本地版本向量
   ├── 无冲突 → 写入本地文件
   └── 有冲突 → 写入 .obsidian-conflicts/ 目录
   │
4. 收集本地变更:
   ├── 对比本地文件修改时间 vs 上次同步状态
   ├── 对每个变更的文件:
   │   ├── 生成/获取 DEK
   │   ├── 加密路径 + 内容
   │   ├── 递增 version_vector[device_id]
   │   └── 加入推送队列
   │
5. 推送本地变更: POST /sync/push
   │
6. 更新 last_sync 时间戳
```

### 5.4 冲突处理详情

```
冲突场景: 设备 A 和设备 B 同时离线编辑同一笔记

设备 A: version_vector = {A: 5, B: 3}
设备 B: version_vector = {A: 4, B: 4}

结果: 两个向量不可比较 → 真正冲突

处理:
  1. 后推送者的版本成为主版本
  2. 先推送者的版本保存到 .obsidian-conflicts/note-name-conflict-<timestamp>.md
  3. 在 Obsidian 通知栏显示冲突提示
```

---

## 六、Telegram → Hermes → Obsidian 管道

### 6.1 消息生命周期

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 频道消息  │───▶│ 主Agent  │───▶│ 子Agent  │───▶│ 内容合并  │───▶│ 清理消息  │
│ Bot 收到  │    │ 分类路由  │    │ 提取整理  │    │ 写入Vault │    │ 删除原消息 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │               │               │               │
                     ▼               ▼               ▼               ▼
              简单→自动派发     复杂→确认用户    成功→删除消息    失败→保留+通知
              链接→Explorer    多步→Kanban     失败→保留+通知
```

### 6.2 主 Agent 路由策略

| 消息类型 | 示例 | 复杂度 | 路由 |
|---------|------|:---:|------|
| 纯链接 | `https://youtube.com/...` | 低 | → **Explorer** 提取 → **Writer** 合并 |
| 链接 + 文字说明 | `这个讲Rust异步的很好 https://...` | 中 | → **Explorer** 提取 + 结合上下文 |
| 视频/音频 | MP4 文件、语音消息 | 中 | → **Explorer** 转写 → **Writer** 整理 |
| 多链接 + 长文 | 多条链接 + 附注 | 高 | → **Kanban** 多 Agent 并行 |
| 碎片想法/摘录 | 纯文字想法 | 低 | → **Writer** 直接合并 |

### 6.3 内容合并决策树

```
新内容到达
  │
  ├── 匹配到 1 个高置信度目标 (>80%)
  │     └── 自动合并 → 删除 Telegram 消息 ✅
  │
  ├── 匹配到 2-3 个候选 (50%-80%)
  │     └── 保留消息 → 通过 Telegram 询问用户目标 📋
  │
  ├── 无匹配 (<50%)
  │     └── 保留消息 → 询问归属 / 建议新建 ❓
  │
  └── 内容提取失败 (链接失效/视频下架)
        └── 保留消息 → 通知失败原因 ❌
```

### 6.4 合并格式规范

合并到已有笔记时，按以下格式追加：

```markdown
### 📺 [标题]
> 来源: [源名称](源URL) | 采集日期: YYYY-MM-DD
> 采集者: @ContributorName
> 类型: #youtube / #article / #tweet / #note

**核心要点:**
- 要点 1
- 要点 2

**摘要:**
内容摘要段落...

**关键引用:**
> 值得保留的原话...
```

### 6.5 Bot 权限要求

| 权限 | 用途 |
|------|------|
| 频道**管理员** | 私密频道 Bot 需管理员身份 |
| `can_read_messages` | 读取所有成员消息 |
| `can_delete_messages` | 合并完成后清理消息 |

---

## 七、部署方案

### 7.1 Docker Compose

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    container_name: obsidian-sync-db
    environment:
      POSTGRES_DB: obsidian_sync
      POSTGRES_USER: syncuser
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U syncuser -d obsidian_sync"]
      interval: 10s
      timeout: 5s
      retries: 5

  sync-api:
    build:
      context: ./sync-api
      dockerfile: Dockerfile
    container_name: obsidian-sync-api
    environment:
      DATABASE_URL: "postgresql+asyncpg://syncuser:${DB_PASSWORD}@postgres:5432/obsidian_sync"
      JWT_SECRET: ${JWT_SECRET}
      HERMES_API_KEY: ${HERMES_API_KEY}
    ports:
      - "127.0.0.1:8080:8000"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    container_name: obsidian-sync-nginx
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - sync-api
    restart: unless-stopped

volumes:
  pgdata:
```

### 7.2 环境变量 (`.env`)

```bash
# 数据库
DB_PASSWORD=<generate-strong-password>

# JWT
JWT_SECRET=<generate-strong-secret>

# Hermes 集成
HERMES_API_KEY=<generate-strong-api-key>

# 可选：Let's Encrypt
DOMAIN=sync.example.com
EMAIL=admin@example.com
```

### 7.3 Sync API Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 7.4 技术栈总结

| 层 | 技术 | 版本 |
|---|------|------|
| API 框架 | FastAPI | ≥0.110 |
| 数据库 | PostgreSQL | 15 |
| 数据库驱动 | asyncpg + SQLAlchemy 2.0 | |
| ORM | SQLAlchemy 2.0 (async) | |
| 认证 | PyJWT | |
| 加密服务端 | 仅存储加密字节，不解密 | |
| 容器 | Docker + Docker Compose | |
| 反代 | Nginx (TLS 终结) | |
| Obsidian 插件 | TypeScript + Obsidian API | |
| 加密库（客户端） | @noble/ciphers + @noble/hashes | |
| 构建 | esbuild | |

---

## 八、安全考量

| 风险 | 缓解措施 |
|------|---------|
| 服务器被入侵 | 所有内容端到端加密，服务器无解密能力 |
| 密码泄露 | Argon2id 密钥派生 + OS Keychain 隔离 |
| 中间人攻击 | TLS 1.3 (Nginx) |
| API 未授权访问 | JWT (用户) + API Key (Hermes) 双重认证 |
| 重放攻击 | 每次加密使用随机 Nonce |
| 路径篡改 | 路径作为 AES-GCM AAD，防篡改 |
| 暴力破解 | Argon2id 高内存成本 + 速率限制 |
| SQL 注入 | SQLAlchemy 参数化查询 |

---

## 九、实施路线图

| 阶段 | 内容 | 产物 |
|:---:|------|------|
| **Phase 1** | Sync Server 开发 | FastAPI + PostgreSQL + Docker Compose |
| **Phase 2** | Obsidian 插件开发 | 加解密 + 双向同步 + 冲突处理 + 设置面板 |
| **Phase 3** | Hermes ↔ Sync API 集成 | 合并写入 + 内容读取 |
| **Phase 4** | Telegram Bot 消息管道 | 频道消息接收 → Hermes 路由 → 清理 |
| **Phase 5** | 智能合并引擎 | 置信度评分 + 自动/询问决策 + 合并格式化 |
| **Phase 6** | 测试 & 文档 | 端到端测试 + 用户文档 |

---

## 十、开放问题

| # | 问题 | 状态 |
|---|------|:---:|
| 1 | Sync Server 部署在哪台 VPS？ | 🔴 待定 |
| 2 | Obsidian 插件走 Community Plugin 审核还是 BRAT 私有分发？ | 🔴 待定 |
| 3 | 合并到已有笔记时，如果笔记正被用户在 Obsidian 中编辑怎么办？ | 🔴 待定 |
| 4 | 私密频道缺少部分权限时（如无法删除消息），降级策略？ | 🔴 待定 |
| 5 | 是否需要支持多 Vault？ | 🔴 待定 |

Sync Server 部署信息：

> 真实 SSH 地址、用户名、密码、API Key、数据库密码等敏感信息不得提交到公开仓库。
> 请在本地 `.env`、服务器环境变量或安全的密钥管理服务中维护。

```text
SSH_HOST=<server-host>
SSH_PORT=<server-port>
SSH_USER=<server-user>
PROJECT_DIR=/home/<project-dir>
```
已有postgres容器：
2e2ba8cbabc4   postgres:18.1-alpine                    "docker-entrypoint.s…"   6 months ago   Up 3 days (healthy)     0.0.0.0:5432->5432/tcp     1Panel-postgresql-cDnZ
