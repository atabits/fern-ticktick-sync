// Fern plugin: TickTick Sync — clean, low-friction OAuth 2.0 two-way sync.

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

// Fixed loopback callback handled automatically by Fern — user never edits host/port.
// Port 18481 stays in the safe 10000–32000 range, avoiding Linux ephemeral ports (32768+)
// and Windows WFP/Hyper-V/VPN reservations (47000+).
const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 18481;
const REDIRECT_PATH = "/callback";
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

// Optional official 1-click OAuth broker (see oauth-worker/worker.js).
// When clientId + tokenBrokerUrl are configured, users sign in with 1 click and zero keys.
const OFFICIAL_OAUTH = {
  clientId: "",
  tokenBrokerUrl: "",
};

const api = createTickTickClient(fern);
const engine = createSyncEngine(fern, api);

let activeTab = "lists"; // "lists" | "log" | "advanced"
let authInProgress = false;
let authError = null;

function isRu() {
  return String(fern.system.locale() || "").toLowerCase().startsWith("ru");
}

function t(ru, en) {
  return isRu() ? ru : en;
}

function getOAuthSetup() {
  if (OFFICIAL_OAUTH.clientId && OFFICIAL_OAUTH.tokenBrokerUrl) {
    return {
      mode: "official",
      clientId: OFFICIAL_OAUTH.clientId,
      tokenUrl: OFFICIAL_OAUTH.tokenBrokerUrl,
      clientSecretKey: undefined,
      tokenAuth: "body",
      ready: true,
    };
  }
  const clientId = String(fern.settings.get("client_id") || "").trim();
  const hasSecret = fern.settings.hasSecret("client_secret");
  return {
    mode: "personal",
    clientId,
    hasSecret,
    tokenUrl: TICKTICK_TOKEN_URL,
    clientSecretKey: "client_secret",
    tokenAuth: "basic",
    ready: Boolean(clientId && hasSecret),
  };
}

function isConnected() {
  return fern.settings.hasSecret("access_token");
}

function formatTime(ms) {
  if (!ms) return t("ещё не запускалась", "not synced yet");
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("ещё не запускалась", "not synced yet");
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function refreshView() {
  fern.views.refresh(VIEW_ID);
}

function openTickTickPortalWithCopy() {
  fern.system.clipboardWrite(REDIRECT_URI);
  fern.system.openExternal(DEVELOPER_PORTAL_URL);
  fern.ui.toast(
    t(
      `Адрес ${REDIRECT_URI} уже в буфере — вставьте его в OAuth redirect URL`,
      `Copied ${REDIRECT_URI} — paste it into OAuth redirect URL`
    ),
    "success"
  );
}

async function startOAuthLogin() {
  if (authInProgress) return;
  const setup = getOAuthSetup();
  if (!setup.ready) {
    fern.ui.openSettings();
    return;
  }

  authInProgress = true;
  authError = null;
  refreshView();

  try {
    fern.ui.toast(
      t(
        "Открываю TickTick в браузере — нажмите «Разрешить»…",
        "Opening TickTick in your browser — click Allow…"
      ),
      "info"
    );
    const res = await fern.oauth.authorize({
      authorizeUrl: TICKTICK_AUTHORIZE_URL,
      tokenUrl: setup.tokenUrl,
      clientId: setup.clientId,
      clientSecretKey: setup.clientSecretKey,
      scopes: TICKTICK_SCOPES,
      redirectHost: REDIRECT_HOST,
      redirectPort: REDIRECT_PORT,
      redirectPath: REDIRECT_PATH,
      tokenAuth: setup.tokenAuth,
      saveAccessTokenAs: "access_token",
      saveRefreshTokenAs: "refresh_token",
      timeoutSec: 180,
    });
    if (res && res.ok) {
      fern.ui.toast(t("TickTick подключён!", "Connected to TickTick!"), "success");
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

async function disconnectAccount() {
  const confirmed = await fern.ui.confirm(
    t("Отключить TickTick?", "Disconnect TickTick?"),
    t(
      "Ваши задачи в Fern и TickTick останутся на месте.",
      "Your tasks in Fern and TickTick will stay untouched."
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
      fern.ui.toast(t("Сначала войдите в TickTick.", "Please sign in to TickTick first."), "warning");
    }
    return { ok: false, error: "not_connected" };
  }
  refreshView();
  const res = await engine.syncNow(opts);
  if (res.skipped) {
    if (showToast) {
      fern.ui.toast(t("Синхронизация уже идёт…", "Sync is already running…"), "info");
    }
    return res;
  }
  if (res.ok && showToast) {
    const s = res.stats;
    const total = (s.pulled || 0) + (s.pushed || 0) + (s.completed || 0) + (s.linked || 0);
    fern.ui.toast(
      total === 0
        ? t("Всё уже синхронизировано", "Everything is up to date")
        : t(
            `Синхронизировано: ↓${s.pulled} ↑${s.pushed} ✓${s.completed}`,
            `Synced: ↓${s.pulled} ↑${s.pushed} ✓${s.completed}`
          ),
      s.errors > 0 ? "warning" : "success"
    );
  } else if (!res.ok && showToast) {
    fern.ui.toast(res.error || "Sync failed", "error");
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
  const setup = getOAuthSetup();

  // Case A: Ready for 1-click OAuth sign-in!
  if (setup.ready) {
    return ui.vstack({ gap: 16, padding: 24 }, [
      ui.hstack({ justify: "between", align: "center" }, [
        ui.vstack({ gap: 4 }, [
          ui.heading("TickTick", 1),
          ui.text({
            text: t(
              "Двусторонняя синхронизация списков и задач между Fern и TickTick.",
              "Two-way sync of lists and tasks between Fern and TickTick."
            ),
            muted: true,
          }),
        ]),
        ui.badge({
          label: authInProgress ? t("Вход…", "Signing in…") : t("Готово ко входу", "Ready to sign in"),
          color: authInProgress ? "#f59e0b" : "#22c55e",
        }),
      ]),

      ui.card({}, [
        ui.vstack({ gap: 12 }, [
          ui.text({
            text: t(
              "Нажмите кнопку ниже — откроется окно TickTick для подтверждения доступа. Существующие задачи объединятся без дублей.",
              "Click below to authorize in TickTick. Existing tasks will be linked automatically without duplicates."
            ),
            muted: true,
          }),
          authError ? ui.text({ text: authError, color: "#ef4444", size: "sm" }) : ui.spacer(0),
          ui.hstack({ gap: 8, wrap: true }, [
            ui.button({
              label: authInProgress
                ? t("Жду подтверждения в браузере…", "Waiting for browser…")
                : t("Войти через TickTick", "Sign In with TickTick"),
              variant: "primary",
              disabled: authInProgress,
              loading: authInProgress,
              onClick: () => startOAuthLogin(),
            }),
            setup.mode === "personal"
              ? ui.button({
                  label: t("Скопировать Redirect URL", "Copy Redirect URL"),
                  variant: "ghost",
                  onClick: () => {
                    fern.system.clipboardWrite(REDIRECT_URI);
                    fern.ui.toast(
                      t(`Скопировано: ${REDIRECT_URI}`, `Copied: ${REDIRECT_URI}`),
                      "success"
                    );
                  },
                })
              : ui.spacer(0),
            setup.mode === "personal"
              ? ui.button({
                  label: t("Изменить ключи", "Edit Keys"),
                  variant: "ghost",
                  onClick: () => fern.ui.openSettings(),
                })
              : ui.spacer(0),
          ]),
        ]),
      ]),
    ]);
  }

  // Case B: One-time 2-step personal key setup (zero jargon, 1-click helpers)
  const missingHint = !setup.clientId && !setup.hasSecret
    ? t("Осталось вставить Client ID и Client Secret", "Paste Client ID and Client Secret")
    : !setup.clientId
      ? t("Осталось вставить Client ID", "Paste Client ID")
      : t("Осталось вставить Client Secret и нажать Save", "Paste Client Secret and click Save");

  return ui.vstack({ gap: 16, padding: 24 }, [
    ui.vstack({ gap: 4 }, [
      ui.heading(t("Подключение TickTick", "Connect TickTick"), 1),
      ui.text({
        text: t(
          "Синхронизирует ваши списки и задачи с мобильным TickTick в обе стороны.",
          "Keeps your lists and tasks in sync with TickTick across desktop and mobile."
        ),
        muted: true,
      }),
    ]),

    ui.card(
      {
        title: t("Настройка за 2 шага (один раз)", "Quick 2-Step Setup (One Time)"),
        subtitle: missingHint,
      },
      [
        ui.vstack({ gap: 14 }, [
          ui.vstack({ gap: 6 }, [
            ui.text({
              text: t(
                "Шаг 1. Создайте бесплатное приложение в TickTick — нужный Redirect URL мы скопируем в буфер автоматически.",
                "Step 1. Create a free app in TickTick — we automatically copy the Redirect URL to your clipboard."
              ),
            }),
            ui.hstack({ gap: 8 }, [
              ui.button({
                label: t("1. Открыть TickTick (адрес скопируется сам)", "1. Open TickTick (Auto-Copy URL)"),
                variant: "secondary",
                onClick: () => openTickTickPortalWithCopy(),
              }),
            ]),
          ]),

          ui.divider(),

          ui.vstack({ gap: 6 }, [
            ui.text({
              text: t(
                "Шаг 2. Скопируйте Client ID и Client Secret и вставьте их в настройки плагина.",
                "Step 2. Copy the generated Client ID and Client Secret into plugin settings."
              ),
            }),
            ui.hstack({ gap: 8 }, [
              ui.button({
                label: t("2. Вставить Client ID и Client Secret", "2. Enter Client ID & Secret"),
                variant: "primary",
                onClick: () => fern.ui.openSettings(),
              }),
            ]),
          ]),
        ]),
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
      label: t("Входящие (Inbox)", "Inbox"),
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
      title: t("Какие списки синхронизировать", "Synced Lists"),
    },
    [
      projects.length === 0
        ? ui.vstack({ gap: 8 }, [
            ...items,
            ui.text({
              text: t(
                "Нажмите «Синхронизировать», чтобы подгрузить ваши списки из TickTick.",
                "Click Sync Now to load your TickTick lists."
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
      title: t("Событий пока нет", "No activity yet"),
      subtitle: t(
        "После синхронизации здесь появятся все изменения задач.",
        "Synced tasks and updates will appear here."
      ),
    });
  }

  return ui.card(
    {
      title: t(`История (${logs.length})`, `Activity (${logs.length})`),
    },
    [
      ui.vstack({ gap: 8 }, [
        ui.hstack({ gap: 8, justify: "end" }, [
          ui.button({
            label: t("Скопировать", "Copy"),
            variant: "ghost",
            size: "sm",
            onClick: () => {
              const text = logs
                .map((l) => `[${formatTime(l.at)}] [${l.level}] ${l.text}`)
                .join("\n");
              fern.system.clipboardWrite(text);
              fern.ui.toast(t("Журнал скопирован", "Log copied"), "success");
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

function renderAdvancedTab() {
  return ui.card(
    {
      title: t("Управление подключением", "Connection & Maintenance"),
      subtitle: t(
        "Если синхронизируете Fern между несколькими ПК, включайте TickTick Sync только на одном основном устройстве.",
        "If syncing Fern across multiple PCs, keep TickTick Sync enabled on one primary PC only."
      ),
    },
    [
      ui.hstack({ gap: 8, wrap: true }, [
        ui.button({
          label: t("Настройки плагина", "Plugin Settings"),
          variant: "secondary",
          size: "sm",
          onClick: () => fern.ui.openSettings(),
        }),
        ui.button({
          label: t("Только забрать из TickTick", "Pull Only Now"),
          variant: "secondary",
          size: "sm",
          disabled: engine.isSyncing(),
          onClick: () => runSync(true, { direction: "pull_only" }),
        }),
        ui.button({
          label: t("Сбросить связи", "Reset Mapping"),
          variant: "secondary",
          size: "sm",
          onClick: async () => {
            const ok = await fern.ui.confirm(
              t("Сбросить связи задач?", "Reset sync mapping?"),
              t(
                "Задачи не удалятся; при следующем синке они свяжутся заново.",
                "Tasks will not be deleted; the next sync will re-link them."
              )
            );
            if (ok) {
              engine.resetMapping();
              refreshView();
            }
          },
        }),
        ui.button({
          label: t("Отключить TickTick", "Disconnect"),
          variant: "destructive",
          size: "sm",
          onClick: () => disconnectAccount(),
        }),
      ]),
    ]
  );
}

function renderConnectedView() {
  const state = engine.loadState();
  const dirtyCount = Object.keys(engine.loadDirtyQueue()).length;
  const linkedCount = Object.keys(state.tasks || {}).length;
  const summary = state.lastSyncSummary || { pulled: 0, pushed: 0 };
  const busy = engine.isSyncing();

  return ui.vstack({ gap: 14, padding: 24 }, [
    ui.hstack({ justify: "between", align: "center", wrap: true }, [
      ui.vstack({ gap: 2 }, [
        ui.heading("TickTick", 1),
        ui.text({
          text: `${t("Последний синк", "Last sync")}: ${formatTime(state.lastSyncAt)}`,
          muted: true,
          size: "sm",
        }),
      ]),
      ui.hstack({ gap: 8, align: "center" }, [
        ui.badge({
          label: busy ? t("Синхронизация…", "Syncing…") : t("Подключено", "Connected"),
          color: busy ? "#f59e0b" : "#22c55e",
        }),
        ui.button({
          label: busy ? t("Синхронизация…", "Syncing…") : t("Синхронизировать", "Sync Now"),
          variant: "primary",
          disabled: busy,
          loading: busy,
          onClick: () => runSync(true),
        }),
      ]),
    ]),

    state.lastError
      ? ui.card({}, [ui.text({ text: state.lastError, color: "#ef4444", size: "sm" })])
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
        { label: t("История", "Activity"), value: "log" },
        { label: t("Дополнительно", "More"), value: "advanced" },
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
        : renderAdvancedTab(),
  ]);
}

function handleLocalTaskEvent(ev) {
  if (!isConnected()) return;
  if (ev.originPlugin === "com.fern.ticktick-sync") return;
  engine.enqueueLocalEvent(ev.kind, ev.entityId, ev.entity);
  refreshView();
}

export function activate() {
  fern.views.register(VIEW_ID, {
    render() {
      return isConnected() ? renderConnectedView() : renderOnboardingView();
    },
  });

  fern.commands.register("sync_now", async () => runSync(true));
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
