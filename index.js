// Fern plugin: TickTick Sync (Official Open API v1 + OAuth 2.0 via SecretsVault)

import fern from "fern";
import * as ui from "fern:ui";
import {
  createTickTickClient,
  TICKTICK_AUTHORIZE_URL,
  TICKTICK_SCOPES,
  TICKTICK_TOKEN_URL,
} from "./ticktick_api.js";
import { createSyncEngine, INBOX_KEY } from "./sync_engine.js";

const VIEW_ID = "sync";
const TIMER_ID = "ticktick-auto-sync";
const DEVELOPER_PORTAL_URL = "https://developer.ticktick.com/manage";

const api = createTickTickClient(fern);
const engine = createSyncEngine(fern, api);

let activeTab = "lists"; // "lists" | "log" | "advanced"
let authInProgress = false;
let authError = null;
let pendingDirtyFlush = false;

function isRu() {
  const loc = String(fern.system.locale() || "").toLowerCase();
  return loc.startsWith("ru");
}

function t(ru, en) {
  return isRu() ? ru : en;
}

function getOAuthConfig() {
  const clientId = String(fern.settings.get("client_id") || "").trim();
  const hasSecret = fern.settings.hasSecret("client_secret");
  const redirectHost = String(fern.settings.get("redirect_host") || "127.0.0.1").trim() || "127.0.0.1";
  const rawPort = Number(fern.settings.get("redirect_port") || 48123);
  const redirectPort = Number.isFinite(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? Math.round(rawPort) : 48123;
  const redirectUri = `http://${redirectHost}:${redirectPort}/callback`;
  return { clientId, hasSecret, redirectHost, redirectPort, redirectUri };
}

function isConnected() {
  return fern.settings.hasSecret("access_token");
}

function formatTime(ms) {
  if (!ms) return t("никогда", "never");
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("никогда", "never");
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function refreshView() {
  fern.views.refresh(VIEW_ID);
}

async function startOAuthLogin() {
  if (authInProgress) return;
  const cfg = getOAuthConfig();
  if (!cfg.clientId || !cfg.hasSecret) {
    authError = t(
      "Сначала заполните Client ID и Client Secret в Настройки → Плагины → TickTick Sync.",
      "Please enter Client ID and Client Secret in Settings → Plugins → TickTick Sync first."
    );
    fern.ui.toast(authError, "warning");
    refreshView();
    return;
  }

  authInProgress = true;
  authError = null;
  refreshView();

  try {
    fern.ui.toast(
      t(
        "Открываю TickTick в браузере — подтвердите доступ…",
        "Opening TickTick in your browser — please approve access…"
      ),
      "info"
    );
    const res = await fern.oauth.authorize({
      authorizeUrl: TICKTICK_AUTHORIZE_URL,
      tokenUrl: TICKTICK_TOKEN_URL,
      clientId: cfg.clientId,
      clientSecretKey: "client_secret",
      scopes: TICKTICK_SCOPES,
      redirectHost: cfg.redirectHost,
      redirectPort: cfg.redirectPort,
      redirectPath: "/callback",
      tokenAuth: "basic",
      saveAccessTokenAs: "access_token",
      saveRefreshTokenAs: "refresh_token",
      timeoutSec: 180,
    });
    if (res && res.ok) {
      fern.ui.toast(
        t(
          "TickTick успешно подключён через OAuth 2.0!",
          "Connected to TickTick via OAuth 2.0!"
        ),
        "success"
      );
      configureAutoSyncTimer();
      refreshView();
      await runSync(true);
    }
  } catch (err) {
    authError = String(err && err.message ? err.message : err);
    fern.ui.toast(authError, "error");
  } finally {
    authInProgress = false;
    refreshView();
  }
}

async function refreshOAuthTokenManually() {
  const cfg = getOAuthConfig();
  if (!cfg.clientId || !fern.settings.hasSecret("refresh_token")) {
    fern.ui.toast(
      t(
        "Нет refresh_token — выполните вход заново через OAuth.",
        "No refresh token stored — please sign in via OAuth again."
      ),
      "warning"
    );
    return;
  }
  try {
    await fern.oauth.refresh({
      tokenUrl: TICKTICK_TOKEN_URL,
      clientId: cfg.clientId,
      clientSecretKey: cfg.hasSecret ? "client_secret" : undefined,
      refreshTokenKey: "refresh_token",
      scopes: TICKTICK_SCOPES,
      tokenAuth: "basic",
      saveAccessTokenAs: "access_token",
      saveRefreshTokenAs: "refresh_token",
    });
    fern.ui.toast(t("Токен TickTick обновлён.", "TickTick OAuth token refreshed."), "success");
  } catch (err) {
    fern.ui.toast(String(err && err.message ? err.message : err), "error");
  } finally {
    refreshView();
  }
}

async function disconnectAccount() {
  const confirmed = await fern.ui.confirm(
    t("Отключить TickTick?", "Disconnect TickTick?"),
    t(
      "OAuth-токены будут удалены из SecretsVault. Ваши задачи в Fern и TickTick останутся нетронутыми.",
      "OAuth tokens will be removed from SecretsVault. Tasks in Fern and TickTick will not be deleted."
    )
  );
  if (!confirmed) return;
  fern.oauth.clearTokens(["access_token", "refresh_token"]);
  fern.timers.clearInterval(TIMER_ID);
  authError = null;
  fern.ui.toast(t("TickTick отключён.", "Disconnected from TickTick."), "info");
  refreshView();
}

async function runSync(showToast = true, opts = {}) {
  if (!isConnected()) {
    if (showToast) {
      fern.ui.toast(
        t("Сначала выполните вход через TickTick OAuth.", "Please sign in via TickTick OAuth first."),
        "warning"
      );
    }
    return { ok: false, error: "not_connected" };
  }
  refreshView();
  const res = await engine.syncNow(opts);
  if (res.skipped) {
    if (showToast) {
      fern.ui.toast(t("Синхронизация уже выполняется…", "Sync is already running…"), "info");
    }
    return res;
  }
  if (res.ok && showToast) {
    const s = res.stats;
    fern.ui.toast(
      t(
        `TickTick: ↓${s.pulled} ↑${s.pushed} ✓${s.completed} ↔${s.linked}`,
        `TickTick: ↓${s.pulled} ↑${s.pushed} ✓${s.completed} ↔${s.linked}`
      ),
      s.errors > 0 ? "warning" : "success"
    );
  } else if (!res.ok && showToast) {
    fern.ui.toast(res.error || "TickTick sync failed", "error");
  }
  refreshView();
  return res;
}

function configureAutoSyncTimer() {
  fern.timers.clearInterval(TIMER_ID);
  if (!isConnected()) return;
  const mins = Number(fern.settings.get("sync_interval_min") ?? 5);
  if (!Number.isFinite(mins) || mins <= 0) return;
  const intervalMs = Math.max(10_000, Math.round(mins * 60 * 1000));
  fern.timers.setInterval(TIMER_ID, intervalMs, async () => {
    if (!isConnected() || engine.isSyncing()) return;
    await runSync(false);
  });
}

function renderOnboardingView() {
  const cfg = getOAuthConfig();
  const ready = Boolean(cfg.clientId && cfg.hasSecret);

  return ui.vstack({ gap: 12, padding: 16 }, [
    ui.hstack({ justify: "between", align: "center" }, [
      ui.heading(t("Синхронизация с TickTick", "TickTick Sync"), 1),
      ui.badge({
        label: authInProgress ? t("Ожидание браузера…", "Waiting for browser…") : t("Не подключено", "Not connected"),
        color: authInProgress ? "#f59e0b" : "#64748b",
      }),
    ]),

    ui.card(
      {
        title: t("Подключение через OAuth 2.0", "Connect via OAuth 2.0"),
        subtitle: t(
          "Токены хранятся в зашифрованном SecretsVault — JS-код плагина их не видит.",
          "Tokens are stored in encrypted SecretsVault — never exposed to plugin JS."
        ),
      },
      [
        ui.vstack({ gap: 10 }, [
          ui.markdown(
            t(
              `1. Откройте **TickTick Developer Portal** и создайте приложение (бесплатно, ~1 минута).\n2. В поле **OAuth redirect URL** укажите точно:\n   \`${cfg.redirectUri}\`\n3. Скопируйте **Client ID** и **Client Secret** в **Настройки → Плагины → TickTick Sync** и нажмите «Сохранить».\n4. Вернитесь сюда и нажмите **«Войти через TickTick»**.`,
              `1. Open **TickTick Developer Portal** and register an app (free, ~1 minute).\n2. Set **OAuth redirect URL** to exactly:\n   \`${cfg.redirectUri}\`\n3. Paste **Client ID** and **Client Secret** in **Settings → Plugins → TickTick Sync** and click Save.\n4. Return here and click **Sign In with TickTick**.`
            )
          ),

          ui.hstack({ gap: 8, wrap: true }, [
            ui.badge({
              label: cfg.clientId ? "Client ID: OK" : t("Client ID: не задан", "Client ID: missing"),
              color: cfg.clientId ? "#22c55e" : "#ef4444",
            }),
            ui.badge({
              label: cfg.hasSecret ? "Client Secret: OK" : t("Client Secret: не задан", "Client Secret: missing"),
              color: cfg.hasSecret ? "#22c55e" : "#ef4444",
            }),
            ui.badge({
              label: `Redirect: ${cfg.redirectUri}`,
            }),
          ]),

          authError
            ? ui.text({ text: authError, color: "#ef4444", size: "sm" })
            : ui.spacer(0),

          ui.hstack({ gap: 8, wrap: true }, [
            ui.button({
              label: authInProgress
                ? t("Жду подтверждения в браузере…", "Waiting for browser…")
                : t("Войти через TickTick (OAuth)", "Sign In with TickTick (OAuth)"),
              variant: "primary",
              disabled: !ready || authInProgress,
              loading: authInProgress,
              onClick: () => startOAuthLogin(),
            }),
            ui.button({
              label: t("Открыть Developer Portal", "Open Developer Portal"),
              variant: "secondary",
              onClick: () => fern.system.openExternal(DEVELOPER_PORTAL_URL),
            }),
            ui.button({
              label: t("Скопировать Redirect URL", "Copy Redirect URL"),
              variant: "ghost",
              onClick: () => {
                fern.system.clipboardWrite(cfg.redirectUri);
                fern.ui.toast(
                  t(`Скопировано: ${cfg.redirectUri}`, `Copied: ${cfg.redirectUri}`),
                  "success"
                );
              },
            }),
          ]),
        ]),
      ]
    ),

    ui.card(
      {
        title: t("Что синхронизируется (Open API v1)", "What Syncs (Open API v1)"),
      },
      [
        ui.markdown(
          t(
            "- **Двусторонне:** списки (проекты), Входящие, открытые задачи, заметки, сроки и время, приоритеты, теги, чеклисты, подзадачи, повторения (RRULE) и закрытие задач.\n- **Умный первый синк:** существующие задачи с тем же названием и датой связываются без дублей.\n- **Ограничения TickTick API v1:** архив старых выполненных задач, Привычки и Помодоро не отдаются официальным API.",
            "- **Two-way:** projects/lists, Inbox, open tasks, notes, due dates/times, priorities, tags, checklists, subtasks, recurrences (RRULE), and task completions.\n- **Smart initial merge:** matching tasks with the same title and due date are linked without duplicates.\n- **TickTick API v1 limits:** historical completed archive, Habits, and Pomodoro are not exposed by the official API."
          )
        ),
      ]
    ),
  ]);
}

function renderListsTab(state) {
  const projects = Object.entries(state.projects || {});
  const items = [
    ui.checkbox({
      key: "proj-inbox",
      checked: state.inboxEnabled !== false,
      label: state.inboxProjectId
        ? `${t("Входящие (Inbox)", "Inbox")} (${state.inboxProjectId})`
        : t("Входящие (Inbox — авто-определение)", "Inbox (auto-detect)"),
      onChange: (checked) => {
        engine.toggleProjectEnabled(INBOX_KEY, checked);
        refreshView();
      },
    }),
  ];

  for (const [ttPid, meta] of projects) {
    items.push(
      ui.checkbox({
        key: `proj-${ttPid}`,
        checked: meta.enabled !== false,
        label: meta.name || ttPid,
        onChange: (checked) => {
          engine.toggleProjectEnabled(ttPid, checked);
          refreshView();
        },
      })
    );
  }

  return ui.card(
    {
      title: t("Синхронизируемые списки", "Synced Lists"),
      subtitle: t(
        "Отметьте списки TickTick, которые нужно синхронизировать с Fern.",
        "Select which TickTick lists should sync with Fern."
      ),
    },
    [
      projects.length === 0
        ? ui.vstack({ gap: 8 }, [
            ...items,
            ui.text({
              text: t(
                "Нажмите «Синхронизировать сейчас», чтобы загрузить список проектов из TickTick.",
                "Click Sync Now to fetch your project list from TickTick."
              ),
              muted: true,
              size: "sm",
            }),
          ])
        : ui.vstack({ gap: 6 }, items),
    ]
  );
}

function renderLogTab() {
  const logs = engine.loadLogs();
  if (logs.length === 0) {
    return ui.emptyState({
      title: t("Журнал синхронизации пуст", "Sync log is empty"),
      subtitle: t(
        "Здесь будут отображаться все созданные, обновлённые и закрытые задачи.",
        "Synced creations, updates, completions, and conflicts will appear here."
      ),
    });
  }

  return ui.card(
    {
      title: t(`Последние события (${logs.length})`, `Recent Activity (${logs.length})`),
    },
    [
      ui.vstack({ gap: 6 }, [
        ui.hstack({ gap: 8, justify: "end" }, [
          ui.button({
            label: t("Скопировать журнал", "Copy Log"),
            variant: "ghost",
            size: "sm",
            onClick: () => {
              const text = logs
                .map((l) => `[${formatTime(l.at)}] [${l.level}] ${l.text}`)
                .join("\n");
              fern.system.clipboardWrite(text);
              fern.ui.toast(t("Журнал скопирован.", "Log copied to clipboard."), "success");
            },
          }),
          ui.button({
            label: t("Очистить", "Clear"),
            variant: "ghost",
            size: "sm",
            onClick: () => {
              engine.clearLogs();
              refreshView();
            },
          }),
        ]),
        ui.scroll(
          { key: "sync-log-scroll", maxHeight: 280 },
          logs.map((entry, idx) =>
            ui.listItem({
              key: `log-${entry.at}-${idx}`,
              title: entry.text,
              trailing: formatTime(entry.at),
              badge: entry.level === "error" ? "ERR" : entry.level === "warn" ? "WARN" : undefined,
            })
          )
        ),
      ]),
    ]
  );
}

function renderAdvancedTab(state) {
  const dir = String(fern.settings.get("sync_direction") || "two_way");
  const conflict = String(fern.settings.get("conflict_policy") || "lww");
  const interval = String(fern.settings.get("sync_interval_min") ?? "5");

  return ui.vstack({ gap: 12 }, [
    ui.card({ title: t("Текущая конфигурация", "Current Configuration") }, [
      ui.vstack({ gap: 6 }, [
        ui.keyValue({ label: t("Направление", "Direction"), value: dir }),
        ui.keyValue({ label: t("Конфликты", "Conflict policy"), value: conflict }),
        ui.keyValue({
          label: t("Авто-синк", "Auto-sync"),
          value: interval === "0" ? t("Вручную", "Manual") : `${interval} min`,
        }),
        ui.keyValue({
          label: "Inbox Project ID",
          value: state.inboxProjectId || t("авто", "auto"),
        }),
      ]),
    ]),

    ui.card(
      {
        title: t("Действия и обслуживание", "Actions & Maintenance"),
        subtitle: t(
          "Если включена E2EE-синхронизация Fern между несколькими ПК, держите TickTick Sync активным только на одном основном ПК.",
          "If using Fern E2EE sync across multiple PCs, keep TickTick Sync enabled on one primary PC only."
        ),
      },
      [
        ui.hstack({ gap: 8, wrap: true }, [
          ui.button({
            label: t("Только забрать из TickTick", "Pull Only Now"),
            variant: "secondary",
            size: "sm",
            disabled: engine.isSyncing(),
            onClick: () => runSync(true, { direction: "pull_only" }),
          }),
          ui.button({
            label: t("Обновить OAuth-токен", "Refresh OAuth Token"),
            variant: "secondary",
            size: "sm",
            onClick: () => refreshOAuthTokenManually(),
          }),
          ui.button({
            label: t("Сбросить связи (mapping)", "Reset Sync Mapping"),
            variant: "secondary",
            size: "sm",
            onClick: async () => {
              const ok = await fern.ui.confirm(
                t("Сбросить таблицу связей?", "Reset sync mapping?"),
                t(
                  "Задачи останутся на месте; при следующем синке выполнится повторное связывание по названию и дате.",
                  "Tasks will not be deleted; the next sync will re-link matching tasks by title and due date."
                )
              );
              if (ok) {
                engine.resetMapping();
                refreshView();
              }
            },
          }),
          ui.button({
            label: t("Отключить аккаунт", "Disconnect Account"),
            variant: "destructive",
            size: "sm",
            onClick: () => disconnectAccount(),
          }),
        ]),
      ]
    ),
  ]);
}

function renderConnectedView() {
  const state = engine.loadState();
  const dirtyCount = Object.keys(engine.loadDirtyQueue()).length;
  const linkedCount = Object.keys(state.tasks || {}).length;
  const summary = state.lastSyncSummary || { pulled: 0, pushed: 0, completed: 0, conflicts: 0 };
  const busy = engine.isSyncing();

  return ui.vstack({ gap: 12, padding: 16 }, [
    ui.hstack({ justify: "between", align: "center", wrap: true }, [
      ui.vstack({ gap: 2 }, [
        ui.heading(t("TickTick Sync", "TickTick Sync"), 1),
        ui.text({
          text: `${t("Последний синк", "Last sync")}: ${formatTime(state.lastSyncAt)}`,
          muted: true,
          size: "sm",
        }),
      ]),
      ui.hstack({ gap: 8, align: "center" }, [
        ui.badge({
          label: busy ? t("Синхронизация…", "Syncing…") : t("OAuth подключён", "OAuth Connected"),
          color: busy ? "#f59e0b" : "#22c55e",
        }),
        ui.button({
          label: busy ? t("Синхронизация…", "Syncing…") : t("Синхронизировать сейчас", "Sync Now"),
          variant: "primary",
          disabled: busy,
          loading: busy,
          onClick: () => runSync(true),
        }),
      ]),
    ]),

    state.lastError
      ? ui.card({ title: t("Последняя ошибка", "Last Error") }, [
          ui.text({ text: state.lastError, color: "#ef4444", size: "sm" }),
        ])
      : ui.spacer(0),

    ui.grid({ cols: 4, gap: 8 }, [
      ui.card({}, [ui.keyValue({ label: t("Связано", "Linked"), value: String(linkedCount) })]),
      ui.card({}, [ui.keyValue({ label: t("Получено ↓", "Pulled ↓"), value: String(summary.pulled || 0) })]),
      ui.card({}, [ui.keyValue({ label: t("Отправлено ↑", "Pushed ↑"), value: String(summary.pushed || 0) })]),
      ui.card({}, [ui.keyValue({ label: t("В очереди", "Queued"), value: String(dirtyCount) })]),
    ]),

    ui.segmentedTabs({
      key: "tt-tabs",
      value: activeTab,
      options: [
        { label: t("Списки", "Lists"), value: "lists" },
        { label: t("Журнал", "Log"), value: "log" },
        { label: t("Управление", "Manage"), value: "advanced" },
      ],
      onChange: (val) => {
        activeTab = val;
        refreshView();
      },
    }),

    activeTab === "lists"
      ? renderListsTab(state)
      : activeTab === "log"
        ? renderLogTab()
        : renderAdvancedTab(state),
  ]);
}

function handleLocalTaskEvent(ev) {
  if (!isConnected()) return;
  if (ev.originPlugin === "com.fern.ticktick-sync") return;
  engine.enqueueLocalEvent(ev.kind, ev.entityId, ev.entity);
  if (!pendingDirtyFlush) {
    pendingDirtyFlush = true;
    // Queue is flushed on the next auto-sync tick or manual sync; keep dirty count fresh in UI.
    refreshView();
    pendingDirtyFlush = false;
  }
}

export function activate() {
  fern.views.register(VIEW_ID, {
    render() {
      return isConnected() ? renderConnectedView() : renderOnboardingView();
    },
  });

  fern.commands.register("sync_now", async () => {
    return runSync(true);
  });

  fern.commands.register("connect", async () => {
    await startOAuthLogin();
    return { connected: isConnected() };
  });

  for (const kind of [
    "task.created",
    "task.updated",
    "task.completed",
    "task.reopened",
    "task.deleted",
  ]) {
    fern.events.on(kind, handleLocalTaskEvent);
  }

  fern.settings.onChange(() => {
    configureAutoSyncTimer();
    refreshView();
  });

  configureAutoSyncTimer();
}

export function deactivate() {
  fern.timers.clearInterval(TIMER_ID);
}
