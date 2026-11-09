# 07. 共享 PI_HOME 与配置后端

> **翻译说明：** 本页是与 [英文源规格](/spec/02-architecture/07-shared-pi-home) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

状态：P1/P2 已在 host-core 实现；P3 记录在 ADR 0348 中。本文是实现拆分；决策与理由见
[ADR 0347](/adr/0347-shared-pi-home-config-backend)。

> 格式说明（2026-11-08）：pi CLI 将提供商与模型存放在 `models.json`，API 密钥存放在
> `auth.json`，非机密设置存放在 `settings.json`。本记录早期草稿沿用了 Hermes 的
> `config.yaml` / `.env` 命名；实现与下文其余正文指的是 pi 的 JSON 文件。

## 1. 目标

让 Desktop 与 pi CLI 描述同一份配置：

```text
PI_HOME (PI_CODING_AGENT_DIR, else ~/.pi/agent)
├── config.yaml        non-secret settings, providers, model bindings
├── .env               provider keys and other secrets, owner-only
├── sessions/          native pi sessions (already shared after P0)
├── skills/            shared skills
├── extensions/        shared trusted extensions
├── prompts/           shared slash-command templates
├── AGENTS.md          shared global instructions
└── ui-preferences.json  per-machine UI state (never config.yaml)
```

`host-core` 是 `config.yaml` 与 `.env` 的唯一写入者。SQLite 仍然是转录、轮次队列、
评审状态、插件状态与 UI 索引的所有者。

## 2. 非目标

- 本次变更不引入远程网关（ADR 0004 继续有效；接缝保留日后实现 `remote` 后端的
  可能）。
- 除新增配置操作外，不改变渲染器使用的 IPC/RPC 信封形状。
- P1/P2 不迁移会话存储。会话由 P3 覆盖，若它们离开 SQLite，则由各自的 ADR 覆盖。

## 3. 当前状态（P0 已落地）

`packages/agent-runtime/src/agent-dir.ts` 解析 `PI_CODING_AGENT_DIR`，并以
`~/.pi/agent` 作为回退，供原生会话、自定义系统提示、提示模板、`AGENTS.md`、可信扩展
和 Desktop 模型导入器使用。读取是共享的；写入不是。提供商、模型绑定与凭据仍存放在
`pi.sqlite` 和密钥库中。

## 4. 目标架构

```text
Renderer (settings, provider CRUD)
        │  existing IPC
Electron main (thin orchestrator; no config file access)
        │  Host RPC
host-core
  ├── config_backend (Rust)      ← only reader/writer of config.yaml + .env
  │     ├── read_config() / write_config_keys()
  │     ├── version_token() + cache invalidation
  │     └── file watcher → config/changed event
  ├── providers domain           ← reads/writes through config_backend
  └── SQLite                     ← transcript, queue, review, plugin state, indexes
```

关键不变量：

1. 每个文件只有一个写入者：`config_backend`。
2. 每次写入都是原子的（`temp` + `fsync` + `rename`），并在 YAML 解析器允许的范围内
   保留未知键与注释。
3. 读取返回 `{ value, version }`；缓存以 `version` 为键。
4. 外部编辑（CLI、编辑器）由 watcher 检测并作为失效事件发布；没有 Desktop 进程
   轮询并重写该文件。
5. 列表 RPC 永不返回机密值；只返回 `hasSecret`。

## 5. 实施阶段

### P1 —— 读路径（Desktop 不写入）

交付物：

- `crates/host-core/src/config_backend.rs`
  - `read_config_doc()`、`read_env_map()`、`version_token()`、
    `watch_config()`。
  - 仅文件后端；`HERMES_CONFIG_BACKEND` 式的后端选择不在范围内。
- `crates/host-core/src/providers/` 优先从 `config.yaml` 读取提供商/模型条目，
  对未被改动的配置回退到既有 SQLite 行。
- 新 RPC：`config.get`、`config.version`、`config.reload`（只读）以及
  `config/changed` 事件。
- Desktop main 订阅 `config/changed`，并要求渲染器刷新提供商列表。

退出标准：在 CLI 中编辑 `config.yaml`，无需重启应用即可在 Desktop 设置中看到；
Desktop 仍然不写入任何内容。

### P2 —— 写路径与一次性迁移

交付物：

- `config_backend` 写入辅助函数：`write_config_keys(path, pairs)` 与
  `set_env_values(path, pairs)`。
- 提供商 CRUD（`providers.create/update/delete/setSecret`）经 host-core 路由，
  写入 `config.yaml` + `.env`，然后在同一事务边界内更新 SQLite 镜像。
- 迁移：
  1. 备份 `PI_HOME` + `pi.sqlite` + 密钥库；
  2. 仅当缺失时才把 SQLite 提供商与机密复制到 `config.yaml` / `.env`；
  3. 在 `config.sharedHome.writeThrough`（默认开启）之后保留一个版本的 SQLite
     镜像；
  4. 回滚会恢复备份并关闭该开关。
- `config.export` 诊断命令永不打印值，只打印键名与 `hasSecret`。

退出标准：任一侧的新增/编辑/删除都会收敛；没有重复行；在 CLI 中删除的提供商在
Desktop 重启后不会重新出现。

### P3 —— 会话与 UI 偏好

- UI 偏好迁移到 `ui-preferences.json`（按机器，而非按配置）。
- 会话：决定 Desktop 原生会话是并入 `PI_HOME/sessions`，还是留在 SQLite。这需要
  单独的 ADR，因为它改变数据所有权并要求迁移。

## 6. 数据与安全规则

- `config.yaml` 与 `.env` 仅所有者可访问（POSIX 上 `0600`；Windows 上使用 ACL）。
- `.env` 的值永不记录到日志、不进入错误字符串、不由 RPC 返回。`redact_secrets`
  必须覆盖文件路径与 `.env` 形状。
- `.env` 写入器保留无关行与注释；它不会为一个键重写整个文件。
- 删除提供商只移除该提供商拥有的键；其他提供商与未知键保持不变。

## 7. 验证

| 层级 | 测试 |
|---|---|
| Rust 单元 | 原子写入、版本令牌变化、注释/未知键保留、`.env` 行保留、`.env` 权限 |
| Rust 集成 | CLI 编辑 `config.yaml` → `config/changed` → 提供商列表反映该改动；Desktop 写入 → 文件内容一致；删除不会复活 |
| 渲染器 | 提供商 CRUD 仍按 RPC 契约工作；错误中不出现直接文件路径 |
| 迁移 | 全新 home、已有 home、仅遗留 SQLite、仅 CLI home、两者冲突；备份与回滚 |
| Lint | 拒绝在 `config_backend` 之外直接 `open`/`read_text`/`stat`/`yaml.dump` `config.yaml` 或 `.env` |

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 迁移期间机密重复 | 先备份，只复制缺失的键，旧库在一个版本内保持只读 |
| Desktop 写入时发生外部编辑 | 版本令牌比较并设置；不一致时拒绝并重新加载 |
| YAML 注释/未知键丢失 | 只触碰受管键的结构化写入器；往返测试 |
| CLI 与 Desktop 的提供商身份冲突 | 每个提供商使用稳定 id；迁移先按 id 去重，再按 `(baseUrl, apiStyle, model set)` 去重 |
| 服务模式生命周期 | 每个 home 单实例锁、明确的停止命令、不做与 Hermes 相同的空闲关闭 |

## 9. 待决问题

1. `config.yaml` 是否应在 `desktop:` 命名空间下保留 Desktop 专属的提供商元数据
   （顺序、启用状态、别名），还是放在 SQLite 中并用稳定连接键关联？
2. 我们是否在同一步采用 Hermes 的 profile 模型（一个网关下多个 `config.yaml`），
   还是暂时保持每个 home 一个 profile？
3. 在 P4 之前是否需要 `remote` 配置后端，还是可以等远程网关 ADR？
