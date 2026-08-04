# OpenSpecs — 桌面客户端切换到自建 den-api（Self-Hosted SSO 端到端）

> 目标：开发模式下桌面客户端（`apps/app` UI + `apps/desktop` Electron 壳）的 Den 控制平面从官方
> OpenWork Cloud（`https://app.openworklabs.com`）切换到自建 `den-api`（`http://127.0.0.1:8790`，
> better-auth SSO + team-autonomy 全套），登录走 better-auth，彻底绕开官方 Cloud。
>
> 分支：`feat/team-autonomy` · 验证日期：2026-08-04
>
> 关键文件：
> - `apps/app/src/app/lib/den.ts`（UI 端 base URL 解析 + 认证客户端）
> - `apps/desktop/electron/main.mjs`（Electron 壳默认 bootstrap URL）
> - `apps/app/.env.local` / `.env.local.example`（vite 环境变量注入）
> - `ee/apps/den-api/.env`（den-api 本地配置：CORS / better-auth trustedOrigins）

---

## 1. 切换机制（VITE_DEN_BASE_URL 注入点）

### 1.1 UI 侧（web / desktop renderer）

`apps/app/src/app/lib/den.ts`：

| 行号 | 常量 | 说明 |
|---|---|---|
| 51–54 | `BUILD_DEN_BASE_URL` | `import.meta.env.VITE_DEN_BASE_URL` 非空则用，否则 `https://app.openworklabs.com` |
| 55–58 | `BUILD_DEN_REQUIRE_SIGNIN` | `import.meta.env.VITE_DEN_REQUIRE_SIGNIN`，默认 false |
| 60–61 | `HOSTED_DEFAULT_DEN_BASE_URL` / `DEFAULT_DEN_BASE_URL` | 兜底官方默认；`DEFAULT_DEN_BASE_URL = BUILD_DEN_BASE_URL` |
| 625–654 | `resolveDenBaseUrls` | `baseUrl`（web 根）+ `apiBaseUrl`（`/api/den` 代理路径推导） |
| 785–847 | `initializeDenBootstrapConfig` | desktop 优先 desktop-bootstrap.json → shell IPC → 官方默认 |
| 907–918 | `buildDenAuthUrl` | 构造 sign-in/sign-up 深链（`desktopAuth=1&desktopScheme=openwork`） |

Vite 从 `apps/app/` 项目根自动加载 `.env.local`（无自定义 `envDir`，见 `apps/app/vite.config.ts`），
`VITE_*` 键注入 `import.meta.env`。切换 = 本地创建 `apps/app/.env.local`：

```bash
# apps/app/.env.local（已被根 .gitignore `.env*.local` 忽略）
VITE_DEN_BASE_URL=http://127.0.0.1:8790
```

模板见 `apps/app/.env.local.example`（已提交）。

### 1.2 Electron 壳侧（desktop runtime）

desktop runtime 下 baseUrl 优先级（`den.ts:785-847` + `apps/desktop/electron/workspace-store.mjs:478-531`）：

1. `desktop-bootstrap.json`（文件，管理员/connect-link 写入）
2. shell IPC fallback：`defaultDenBaseUrl`（来自 `main.mjs` 的 `DEFAULT_DEN_BASE_URL`，经
   `preload.mjs:51-57` 的 `openwork:desktop-bootstrap-sync` 通道进入 `meta.desktopBootstrap`）
3. 官方默认 `https://app.openworklabs.com`

`apps/desktop/electron/main.mjs:909` 原为硬编码 `"https://app.openworklabs.com"`，无环境变量覆盖。
本次新增 `OPENWORK_DEN_BASE_URL` 环境变量覆盖（未设置时行为不变）：

```js
const DEFAULT_DEN_BASE_URL =
  (process.env.OPENWORK_DEN_BASE_URL ?? "").trim() || "https://app.openworklabs.com";
```

启动桌面开发模式时注入（与 vite 注入保持一致）：

```bash
OPENWORK_DEN_BASE_URL=http://127.0.0.1:8790 pnpm --filter @openwork/desktop dev
# 或任意 shell 前置环境变量后运行 apps/desktop/scripts/electron-dev.mjs
```

## 2. den-api SSO 配置（ee/apps/den-api/.env）

- `BETTER_AUTH_URL=http://localhost:3005` **保持不动**：它是 den-api 的身份 base URL
  （OAuth 回调/邀请链接等绝对 URL 的生成基准），不是桌面 UI 的 origin；桌面端直连
  `http://127.0.0.1:8790` 时 cookie 由响应 host 决定，无需改。
- `CORS_ORIGINS` 与 `DEN_BETTER_AUTH_TRUSTED_ORIGINS` **追加桌面 UI origin** `http://localhost:5173,http://127.0.0.1:5173`：
  - web 开发模式（浏览器直开 `localhost:5173`）请求带 `Origin: http://localhost:5173`，需要 CORS + better-auth CSRF 白名单；
  - desktop 模式请求经 Electron main 代理（`den.ts:2026-2036` `resolveFetch`，跨源 loopback → `desktopFetchViaMain`），无浏览器 CORS 限制。
- better-auth 端点：`GET /api/auth/get-session`（未登录返回 `null`，200）；email/password 端点
  `/api/auth/sign-in/email` 与 `/api/auth/sign-up/email`（den.ts `createDenClient.signInEmail/signUpEmail` 直接调用）。

## 3. 验证证据（2026-08-04）

```bash
# 1) UI 侧 vite 注入（den.ts transform 后 import.meta.env 替换结果）
$ curl http://localhost:5173/src/app/lib/den.ts | grep VITE_DEN_BASE_URL
"VITE_DEN_BASE_URL": "http://127.0.0.1:8790"     # ← 注入生效
... || "https://app.openworklabs.com";            # ← 未配置时官方默认兜底保留

# 2) Electron 壳覆盖逻辑（main.mjs:909 改动后）
$ node -e "..." 
with OPENWORK_DEN_BASE_URL  -> http://127.0.0.1:8790
unset (official default)    -> https://app.openworklabs.com

# 3) better-auth 端点正常（未登录）
$ curl http://127.0.0.1:8790/api/auth/get-session
null                                   # 200，会话为空 → 认证链路可达
$ curl -X POST -H "Origin: http://localhost:5173" -d '{"email":"","password":""}' \
    http://127.0.0.1:8790/api/auth/sign-in/email
HTTP/1.1 400 Bad Request                # 端点被 better-auth 处理（空凭据被拒）

# 4) CORS（web dev 模式 5173 → 8790 直连）
$ curl -X OPTIONS -H "Origin: http://localhost:5173" \
    -H "Access-Control-Request-Method: POST" http://127.0.0.1:8790/api/auth/sign-in/email
HTTP/1.1 204 No Content
access-control-allow-credentials: true
access-control-allow-headers: Content-Type,Authorization,...
access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS

# 5) 团队自治 API 认证拦截生效（未认证 → 401）
$ curl http://127.0.0.1:8790/api/teams/team_x/agents
HTTP/1.1 401 Unauthorized
{"error":"unauthorized"}
```

注：本机 curl 需 `--noproxy '*'`（环境存在 `HTTP_PROXY=http://127.0.0.1:7890`，否则 8790 请求会被本地代理拦成 502）。

## 4. 官方 Cloud 与自建的边界

| 面 | 官方 Cloud | 自建 den-api（本次） | 归属 |
|---|---|---|---|
| UI base URL（web/desktop） | `https://app.openworklabs.com` | `http://127.0.0.1:8790`（`VITE_DEN_BASE_URL` / `OPENWORK_DEN_BASE_URL`） | 本次 |
| 认证 | 官方 SSO + deep-link（`desktopAuth=1&desktopScheme=openwork`） | better-auth email/password + SSO 插件（`/api/auth/*`） | 本次（API 层） |
| 登录页 UI | 官方登录页（`buildDenAuthUrl` 打开） | **尚无**：den-api 是纯 API，根路径无登录 HTML；`buildDenAuthUrl(baseUrl)` 指向 `http://127.0.0.1:8790/?mode=sign-in...` 只会得到 API 根 payload。需 den-api web 前端（3005）或桌面内嵌表单承接，**属后续任务** | 后续 |
| 本地 workspace（4096） | 不受影响 | 不受影响（`DEFAULT_LOCAL_BASE_URL` 独立） | — |
| 未配置默认值 | — | 官方默认保留（`VITE_DEN_BASE_URL` 空 → `app.openworklabs.com`；`OPENWORK_DEN_BASE_URL` 空 → 官方默认） | 本次约束 |
| connect-link / desktop-bootstrap.json | 运行时覆盖 baseUrl | 同一机制，优先级高于 build/env 默认 | 既有机制 |

### 4.1 已改动文件（本次 commit）

- `apps/desktop/electron/main.mjs` — `DEFAULT_DEN_BASE_URL` 支持 `OPENWORK_DEN_BASE_URL` 覆盖
- `apps/app/.env.local.example` — 自建控制平面注入模板（新增，`apps/app/.env.local` 本地生效、git-ignored）
- `.gitignore` — 豁免 `!.env.local.example`
- `ee/apps/den-api/.env`（**未跟踪**，不随 commit）— CORS / trustedOrigins 追加 5173
