// 3-way TickTick Open API v1 <-> Fern synchronization engine.
// Handles initial deduplication, vanished-task completed-vs-deleted detection,
// recurring task copyId rebinding, subtask topological ordering, and offline dirty queue.

import {
  canonicalTaskHash,
  dedupKey,
  fernTaskToTtPayload,
  normalizeFernTask,
  normalizedToFernPatch,
  normalizeTickTickTask,
  parseModifiedMs,
} from "./date_convert.js";

const STATE_KEY = "tt_sync_state_v1";
const DIRTY_KEY = "tt_dirty_queue_v1";
const LOG_KEY = "tt_sync_log_v1";
const MAX_LOG_ENTRIES = 40;
export const INBOX_KEY = "__inbox__";

export function defaultSyncState() {
  return {
    projects: {}, // { [ttProjectId]: { fernListId: string|null, name: string, color: string|null, enabled: boolean, isInbox?: boolean } }
    tasks: {}, // { [fernId]: { ttId, ttProjectId, baseHash, lastSyncedAt, isRecurring } }
    ttToFern: {}, // { [ttId]: fernId }
    inboxProjectId: null,
    inboxEnabled: true,
    lastSyncAt: null,
    lastSyncSummary: null,
    lastError: null,
  };
}

function topoSortTasks(tasks, idKey = "id", parentKey = "parentId") {
  const byId = new Map();
  for (const t of tasks) byId.set(t[idKey], t);
  const visited = new Set();
  const visiting = new Set();
  const out = [];

  function visit(task) {
    const id = task[idKey];
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const pid = task[parentKey];
    if (pid && byId.has(pid)) {
      visit(byId.get(pid));
    }
    visiting.delete(id);
    visited.add(id);
    out.push(task);
  }

  for (const t of tasks) visit(t);
  return out;
}

export function createSyncEngine(fern, api) {
  let syncing = false;

  function loadState() {
    const raw = fern.storage.get(STATE_KEY);
    if (!raw || typeof raw !== "object") return defaultSyncState();
    return {
      ...defaultSyncState(),
      ...raw,
      projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
      tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {},
      ttToFern: raw.ttToFern && typeof raw.ttToFern === "object" ? raw.ttToFern : {},
    };
  }

  function saveState(state) {
    fern.storage.set(STATE_KEY, state);
  }

  function loadDirtyQueue() {
    const raw = fern.storage.get(DIRTY_KEY);
    return raw && typeof raw === "object" ? raw : {};
  }

  function saveDirtyQueue(queue) {
    fern.storage.set(DIRTY_KEY, queue);
  }

  function loadLogs() {
    const raw = fern.storage.get(LOG_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  function appendLog(level, text) {
    const logs = loadLogs();
    logs.unshift({ at: Date.now(), level, text });
    if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
    fern.storage.set(LOG_KEY, logs);
  }

  function clearLogs() {
    fern.storage.set(LOG_KEY, []);
  }

  function getOption(key, fallback) {
    const val = fern.settings.get(key);
    return val === null || val === undefined || val === "" ? fallback : val;
  }

  function enqueueLocalEvent(kind, entityId, entity) {
    if (!entityId) return;
    const queue = loadDirtyQueue();
    let op = "upsert";
    if (kind === "task.deleted") op = "delete";
    else if (kind === "task.completed") op = "complete";
    else if (kind === "task.reopened") op = "upsert";

    const existing = queue[entityId];
    // Preserve delete over earlier upsert.
    if (existing && existing.op === "delete" && op !== "upsert") {
      return;
    }
    queue[entityId] = {
      op,
      at: Date.now(),
      listId: entity && entity.listId ? entity.listId : null,
      repeat: entity && entity.repeat ? entity.repeat : null,
    };
    saveDirtyQueue(queue);
  }

  function toggleProjectEnabled(ttProjectId, enabled) {
    const state = loadState();
    if (ttProjectId === INBOX_KEY) {
      state.inboxEnabled = Boolean(enabled);
    } else if (state.projects[ttProjectId]) {
      state.projects[ttProjectId].enabled = Boolean(enabled);
    }
    saveState(state);
    return state;
  }

  function resetMapping() {
    const prev = loadState();
    const fresh = defaultSyncState();
    fresh.inboxProjectId = prev.inboxProjectId;
    fresh.inboxEnabled = prev.inboxEnabled;
    saveState(fresh);
    saveDirtyQueue({});
    appendLog("info", "Sync mapping reset (tasks in Fern and TickTick were kept untouched).");
    return fresh;
  }

  function readFernChecklist(taskId) {
    try {
      const items = fern.tasks.checklist(taskId);
      return Array.isArray(items) ? items : [];
    } catch (_err) {
      return [];
    }
  }

  function unlinkTask(state, fernId) {
    const link = state.tasks[fernId];
    if (link && link.ttId && state.ttToFern[link.ttId] === fernId) {
      delete state.ttToFern[link.ttId];
    }
    delete state.tasks[fernId];
  }

  function linkTask(state, fernId, ttId, ttProjectId, baseHash, isRecurring) {
    // Clean any stale reverse mapping.
    const prev = state.tasks[fernId];
    if (prev && prev.ttId && prev.ttId !== ttId && state.ttToFern[prev.ttId] === fernId) {
      delete state.ttToFern[prev.ttId];
    }
    state.tasks[fernId] = {
      ttId,
      ttProjectId,
      baseHash,
      lastSyncedAt: Date.now(),
      isRecurring: Boolean(isRecurring),
    };
    state.ttToFern[ttId] = fernId;
  }

  function resolveFernListForTtProject(state, ttProjectId) {
    if (!ttProjectId) return null;
    if (state.inboxProjectId && ttProjectId === state.inboxProjectId) return null;
    if (String(ttProjectId).startsWith("inbox")) return null;
    const proj = state.projects[ttProjectId];
    return proj ? proj.fernListId || null : null;
  }

  function resolveTtProjectForFernList(state, fernListId) {
    if (!fernListId) {
      return state.inboxEnabled ? state.inboxProjectId || null : null;
    }
    for (const [ttPid, meta] of Object.entries(state.projects)) {
      if (meta && meta.enabled && meta.fernListId === fernListId) {
        return ttPid;
      }
    }
    return null;
  }

  async function syncNow(opts = {}) {
    if (syncing) {
      return { skipped: true, reason: "already_running" };
    }
    syncing = true;

    const stats = {
      pulled: 0,
      pushed: 0,
      completed: 0,
      deleted: 0,
      linked: 0,
      conflicts: 0,
      errors: 0,
    };

    const direction = opts.direction || String(getOption("sync_direction", "two_way"));
    const allowPull = direction === "two_way" || direction === "pull_only";
    const allowPush = direction === "two_way" || direction === "push_only";
    const conflictPolicy = String(getOption("conflict_policy", "lww"));
    const deletePolicy = String(getOption("delete_policy", "trash"));
    const configuredInboxId = String(getOption("inbox_project_id", "")).trim() || null;

    const state = loadState();
    const dirty = loadDirtyQueue();

    try {
      // 1. Reconcile TickTick projects <-> Fern lists
      const remoteProjects = await api.listProjects();
      const fernLists = fern.lists.all();
      const fernListById = new Map();
      const fernListByName = new Map();
      for (const lst of fernLists) {
        fernListById.set(lst.id, lst);
        const key = String(lst.name || "").trim().toLowerCase();
        if (key && !fernListByName.has(key)) {
          fernListByName.set(key, lst);
        }
      }

      const activeRemoteProjectIds = new Set();
      for (const proj of remoteProjects) {
        if (!proj || !proj.id || proj.closed) continue;
        activeRemoteProjectIds.add(proj.id);
        const prev = state.projects[proj.id];
        let fernListId = prev && prev.fernListId && fernListById.has(prev.fernListId)
          ? prev.fernListId
          : null;
        const enabled = prev ? prev.enabled !== false : true;

        if (!fernListId && enabled) {
          const matched = fernListByName.get(String(proj.name || "").trim().toLowerCase());
          if (matched) {
            fernListId = matched.id;
          } else if (allowPull) {
            const created = fern.lists.create({
              name: proj.name || "TickTick",
              color: proj.color || undefined,
            });
            fernListId = created.id;
            fernListById.set(created.id, created);
            fernListByName.set(String(created.name).trim().toLowerCase(), created);
            appendLog("info", `Created Fern list "${created.name}" from TickTick project.`);
          }
        }

        state.projects[proj.id] = {
          fernListId,
          name: proj.name || "Untitled",
          color: proj.color || null,
          enabled,
        };
      }

      // 2. Pull open tasks from all enabled TickTick projects + Inbox
      const remoteById = new Map();
      const fetchedProjectIds = new Set();

      if (state.inboxEnabled) {
        const inboxRes = await api.getInboxData(configuredInboxId || state.inboxProjectId);
        if (inboxRes.inboxId) {
          state.inboxProjectId = inboxRes.inboxId;
        }
        if (inboxRes.ok) {
          if (state.inboxProjectId) fetchedProjectIds.add(state.inboxProjectId);
          for (const t of inboxRes.tasks) {
            if (!t || !t.id) continue;
            if (!state.inboxProjectId && t.projectId) {
              state.inboxProjectId = t.projectId;
              fetchedProjectIds.add(t.projectId);
            }
            remoteById.set(t.id, t);
          }
        }
      }

      for (const [ttPid, meta] of Object.entries(state.projects)) {
        if (!meta || !meta.enabled || !activeRemoteProjectIds.has(ttPid)) continue;
        fetchedProjectIds.add(ttPid);
        const pdata = await api.getProjectData(ttPid);
        for (const t of pdata.tasks) {
          if (t && t.id) remoteById.set(t.id, t);
        }
      }

      // 3. Snapshot Fern tasks (including deleted & completed so we can detect local deletes/completions)
      const allFernTasks = fern.tasks.list({ includeDeleted: true });
      const fernById = new Map();
      const fernChecklistCache = new Map();
      for (const t of allFernTasks) {
        fernById.set(t.id, t);
      }

      function getChecklist(fernId) {
        if (!fernChecklistCache.has(fernId)) {
          fernChecklistCache.set(fernId, readFernChecklist(fernId));
        }
        return fernChecklistCache.get(fernId);
      }

      // Helper to find a newly spawned recurring sibling in Fern when a linked recurring task completes
      function findRecurringSuccessor(completedTask) {
        if (!completedTask.repeat) return null;
        for (const cand of allFernTasks) {
          if (
            cand.id !== completedTask.id &&
            !cand.deletedAt &&
            !cand.completed &&
            !state.tasks[cand.id] &&
            cand.title === completedTask.title &&
            cand.listId === completedTask.listId &&
            cand.repeat === completedTask.repeat
          ) {
            return cand;
          }
        }
        return null;
      }

      // 4. Phase A + B — Reconcile every existing linked task
      const linkedFernIds = Object.keys(state.tasks);
      for (const fernId of linkedFernIds) {
        const link = state.tasks[fernId];
        if (!link) continue;
        const localTask = fernById.get(fernId) || null;
        const remoteTask = remoteById.get(link.ttId) || null;
        const dirtyEntry = dirty[fernId] || null;

        try {
          // Case 1: Deleted locally in Fern
          if (!localTask || localTask.deletedAt) {
            if (allowPush && remoteTask) {
              await api.deleteTask(remoteTask.projectId || link.ttProjectId, link.ttId);
              remoteById.delete(link.ttId);
              stats.deleted++;
              appendLog("info", `↑ Deleted in TickTick: "${remoteTask.title}"`);
            }
            unlinkTask(state, fernId);
            delete dirty[fernId];
            continue;
          }

          // Case 2: Completed locally in Fern while still open in TickTick
          if (localTask.completed) {
            if (allowPush && remoteTask) {
              await api.completeTask(remoteTask.projectId || link.ttProjectId, link.ttId);
              remoteById.delete(link.ttId);
              stats.completed++;
              appendLog("info", `↑ Completed in TickTick: "${localTask.title}"`);

              // Rebind recurring task link to Fern's newly generated next occurrence!
              const successor = findRecurringSuccessor(localTask);
              unlinkTask(state, fernId);
              if (successor) {
                const succNorm = normalizeFernTask(successor, getChecklist(successor.id));
                linkTask(
                  state,
                  successor.id,
                  link.ttId,
                  remoteTask.projectId || link.ttProjectId,
                  canonicalTaskHash(succNorm),
                  true
                );
                appendLog("info", `↻ Rebound recurring task "${successor.title}" to next occurrence.`);
              }
            } else {
              unlinkTask(state, fernId);
            }
            delete dirty[fernId];
            continue;
          }

          // Case 3: Local task is open, but remote vanished from open-task lists
          if (!remoteTask) {
            // Only investigate if the task's project was actually fetched this round.
            if (!fetchedProjectIds.has(link.ttProjectId)) {
              continue;
            }
            const probed = await api.getTask(link.ttProjectId, link.ttId);
            if (probed && (Number(probed.status || 0) >= 1 || probed.completedTime)) {
              if (allowPull) {
                const res = fern.tasks.complete(fernId);
                stats.completed++;
                appendLog("info", `↓ Completed from TickTick: "${localTask.title}"`);
                unlinkTask(state, fernId);
                if (res && res.copyId && localTask.repeat) {
                  const nextTask = fern.tasks.get(res.copyId);
                  if (nextTask) {
                    const nextNorm = normalizeFernTask(nextTask, readFernChecklist(nextTask.id));
                    linkTask(
                      state,
                      nextTask.id,
                      link.ttId,
                      link.ttProjectId,
                      canonicalTaskHash(nextNorm),
                      true
                    );
                  }
                }
              }
            } else if (!probed) {
              if (allowPull && deletePolicy === "trash") {
                fern.tasks.delete(fernId);
                stats.deleted++;
                appendLog("info", `↓ Moved to Trash (deleted in TickTick): "${localTask.title}"`);
              } else {
                appendLog("info", `Unlinked (deleted in TickTick): "${localTask.title}"`);
              }
              unlinkTask(state, fernId);
            }
            delete dirty[fernId];
            continue;
          }

          // Case 4: Open on both sides — 3-way hash comparison!
          const remoteProjectId = remoteTask.projectId || link.ttProjectId;
          const mappedFernListId = resolveFernListForTtProject(state, remoteProjectId);
          const mappedFernParentId = remoteTask.parentId
            ? state.ttToFern[remoteTask.parentId] || null
            : null;

          const localChecklist = getChecklist(fernId);
          const localNorm = normalizeFernTask(localTask, localChecklist);
          const remoteNorm = normalizeTickTickTask(remoteTask, mappedFernListId, mappedFernParentId);

          const localHash = canonicalTaskHash(localNorm);
          const remoteHash = canonicalTaskHash(remoteNorm);

          if (localHash === link.baseHash && remoteHash === link.baseHash) {
            // Unchanged on both sides.
            if (remoteProjectId !== link.ttProjectId) {
              link.ttProjectId = remoteProjectId;
            }
            delete dirty[fernId];
            continue;
          }

          if (localHash === remoteHash) {
            linkTask(state, fernId, link.ttId, remoteProjectId, localHash, Boolean(localNorm.repeat));
            delete dirty[fernId];
            continue;
          }

          const localChanged = localHash !== link.baseHash || Boolean(dirtyEntry);
          const remoteChanged = remoteHash !== link.baseHash;

          let action = "none";
          if (localChanged && !remoteChanged) {
            action = allowPush ? "push" : "none";
          } else if (!localChanged && remoteChanged) {
            action = allowPull ? "pull" : "none";
          } else if (localChanged && remoteChanged) {
            stats.conflicts++;
            if (conflictPolicy === "fern_wins") {
              action = allowPush ? "push" : allowPull ? "pull" : "none";
            } else if (conflictPolicy === "ticktick_wins") {
              action = allowPull ? "pull" : allowPush ? "push" : "none";
            } else {
              // Last-Write-Wins comparing Fern modifiedAt/createdAt vs TickTick modifiedTime
              const localMs = Number(localTask.modifiedAt || localTask.createdAt || 0);
              const remoteMs = parseModifiedMs(remoteTask);
              action = localMs >= remoteMs ? (allowPush ? "push" : "pull") : (allowPull ? "pull" : "push");
            }
            appendLog(
              "warn",
              `Conflict on "${localTask.title}" -> resolved via ${action} (${conflictPolicy}).`
            );
          }

          if (action === "pull") {
            const patch = normalizedToFernPatch(remoteNorm);
            const updated = fern.tasks.update(fernId, patch);
            fernById.set(fernId, updated);
            fernChecklistCache.set(fernId, remoteNorm.checklist);
            const finalHash = canonicalTaskHash(normalizeFernTask(updated, remoteNorm.checklist));
            linkTask(state, fernId, link.ttId, remoteProjectId, finalHash, Boolean(remoteNorm.repeat));
            stats.pulled++;
            appendLog("info", `↓ Updated in Fern: "${updated.title}"`);
          } else if (action === "push") {
            const targetTtPid = resolveTtProjectForFernList(state, localTask.listId) || remoteProjectId;
            const ttParentId = localTask.parentId && state.tasks[localTask.parentId]
              ? state.tasks[localTask.parentId].ttId
              : null;
            const payload = fernTaskToTtPayload(
              localTask,
              localChecklist,
              targetTtPid,
              link.ttId,
              ttParentId
            );
            await api.updateTask(link.ttId, payload);
            linkTask(state, fernId, link.ttId, targetTtPid, localHash, Boolean(localNorm.repeat));
            stats.pushed++;
            appendLog("info", `↑ Updated in TickTick: "${localTask.title}"`);
          }
          delete dirty[fernId];
        } catch (err) {
          stats.errors++;
          appendLog("error", `Sync error on "${localTask ? localTask.title : fernId}": ${String(err.message || err)}`);
        }
      }

      // 5. Phase C — Pull unlinked open tasks from TickTick into Fern (with smart dedup)
      if (allowPull) {
        const unlinkedRemote = [];
        for (const [ttId, ttTask] of remoteById.entries()) {
          if (!state.ttToFern[ttId]) {
            unlinkedRemote.push(ttTask);
          }
        }

        // Build dedup index of currently unlinked open Fern tasks grouped by listId
        const unlinkedFernByListAndKey = new Map();
        for (const ft of allFernTasks) {
          if (ft.deletedAt || ft.completed || state.tasks[ft.id]) continue;
          const bucketKey = `${ft.listId || INBOX_KEY}::${dedupKey(ft.title, ft.dueDate)}`;
          if (!unlinkedFernByListAndKey.has(bucketKey)) {
            unlinkedFernByListAndKey.set(bucketKey, ft);
          }
        }

        const orderedRemote = topoSortTasks(unlinkedRemote, "id", "parentId");
        const toCreate = [];

        for (const ttTask of orderedRemote) {
          const ttPid = ttTask.projectId || state.inboxProjectId;
          const fernListId = resolveFernListForTtProject(state, ttPid);
          const fernParentId = ttTask.parentId ? state.ttToFern[ttTask.parentId] || null : null;
          const norm = normalizeTickTickTask(ttTask, fernListId, fernParentId);

          // Smart deduplication on first sync: link matching open task instead of duplicating.
          const dk = `${fernListId || INBOX_KEY}::${dedupKey(norm.title, norm.dueDate)}`;
          const dup = unlinkedFernByListAndKey.get(dk);
          if (dup && !state.tasks[dup.id]) {
            unlinkedFernByListAndKey.delete(dk);
            const localNorm = normalizeFernTask(dup, getChecklist(dup.id));
            linkTask(
              state,
              dup.id,
              ttTask.id,
              ttPid,
              canonicalTaskHash(localNorm),
              Boolean(norm.repeat || dup.repeat)
            );
            stats.linked++;
            appendLog("info", `↔ Linked existing task (no duplicate): "${dup.title}"`);
          } else {
            toCreate.push({ ttTask, ttPid, norm });
          }
        }

        if (toCreate.length > 0) {
          fern.batch(() => {
            for (const entry of toCreate) {
              const fernParentId = entry.ttTask.parentId
                ? state.ttToFern[entry.ttTask.parentId] || null
                : null;
              const patch = normalizedToFernPatch({ ...entry.norm, parentId: fernParentId });
              const created = fern.tasks.create(patch);
              if (fernParentId) {
                fern.tasks.update(created.id, { parentId: fernParentId });
              }
              const fresh = fern.tasks.get(created.id) || created;
              fernById.set(fresh.id, fresh);
              const hash = canonicalTaskHash(normalizeFernTask(fresh, entry.norm.checklist));
              linkTask(
                state,
                fresh.id,
                entry.ttTask.id,
                entry.ttPid,
                hash,
                Boolean(entry.norm.repeat)
              );
              stats.pulled++;
            }
          });
          appendLog("info", `↓ Imported ${toCreate.length} new task(s) from TickTick.`);
        }
      }

      // 6. Phase D — Push unlinked open Fern tasks in enabled lists to TickTick
      if (allowPush) {
        const unlinkedLocal = [];
        for (const ft of allFernTasks) {
          if (ft.deletedAt || ft.completed || state.tasks[ft.id]) continue;
          const targetTtPid = resolveTtProjectForFernList(state, ft.listId);
          if (!targetTtPid && ft.listId !== null) continue; // list not enabled for TickTick sync
          if (!targetTtPid && ft.listId === null && !state.inboxEnabled) continue;
          unlinkedLocal.push({ task: ft, targetTtPid });
        }

        const orderedLocal = topoSortTasks(
          unlinkedLocal.map((x) => x.task),
          "id",
          "parentId"
        );
        const targetByFernId = new Map(unlinkedLocal.map((x) => [x.task.id, x.targetTtPid]));

        for (const ft of orderedLocal) {
          try {
            const targetTtPid = targetByFernId.get(ft.id);
            const ttParentId = ft.parentId && state.tasks[ft.parentId]
              ? state.tasks[ft.parentId].ttId
              : null;
            const checklist = getChecklist(ft.id);
            const payload = fernTaskToTtPayload(ft, checklist, targetTtPid, null, ttParentId);
            const created = await api.createTask(payload);
            const resolvedPid = created.projectId || targetTtPid;
            if (!state.inboxProjectId && ft.listId === null && resolvedPid) {
              state.inboxProjectId = resolvedPid;
            }
            const hash = canonicalTaskHash(normalizeFernTask(ft, checklist));
            linkTask(state, ft.id, created.id, resolvedPid, hash, Boolean(ft.repeat));
            delete dirty[ft.id];
            stats.pushed++;
          } catch (err) {
            stats.errors++;
            appendLog("error", `↑ Push failed for "${ft.title}": ${String(err.message || err)}`);
          }
        }
        if (stats.pushed > 0) {
          appendLog("info", `↑ Pushed ${stats.pushed} task change(s) to TickTick.`);
        }
      }

      state.lastSyncAt = Date.now();
      state.lastSyncSummary = stats;
      state.lastError = stats.errors > 0 ? `${stats.errors} item(s) had sync errors (see log)` : null;
      saveState(state);
      saveDirtyQueue(dirty);
      return { ok: true, stats, state };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      state.lastError = msg;
      saveState(state);
      appendLog("error", `Sync failed: ${msg}`);
      return { ok: false, error: msg, stats, state };
    } finally {
      syncing = false;
    }
  }

  return {
    loadState,
    loadDirtyQueue,
    loadLogs,
    clearLogs,
    enqueueLocalEvent,
    toggleProjectEnabled,
    resetMapping,
    syncNow,
    isSyncing: () => syncing,
  };
}
