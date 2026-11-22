// 3-way TickTick Open API v1 <-> Fern synchronization engine.
// Handles initial deduplication, vanished-task completed-vs-deleted detection,
// recurring task completion semantics, subtask topological ordering, and offline dirty queue.

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
const INITIAL_DEDUP_BASE_HASH = "__initial_dedup_divergence__";
export const INBOX_KEY = "__inbox__";

export function defaultSyncState() {
  return {
    projects: {}, // { [ttProjectId]: { fernListId: string|null, name: string, color: string|null, enabled: boolean } }
    tasks: {}, // { [fernId]: { ttId, ttProjectId, baseHash, lastSyncedAt, isRecurring } }
    ttToFern: {}, // { [ttId]: fernId }
    unlinkedFernIds: {}, // { [fernId]: timestamp } tombstones for delete_policy: "unlink"
    inboxProjectId: null,
    inboxEnabled: true,
    mappingEpoch: 0,
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

function isAbortingApiError(err) {
  return Boolean(err && (err.fatal || err.status === 401 || err.status === 429));
}

export function createSyncEngine(fern, api) {
  let syncing = false;
  let dirtySeq = 0;

  function loadState() {
    const raw = fern.storage.get(STATE_KEY);
    if (!raw || typeof raw !== "object") return defaultSyncState();
    return {
      ...defaultSyncState(),
      ...raw,
      projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
      tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {},
      ttToFern: raw.ttToFern && typeof raw.ttToFern === "object" ? raw.ttToFern : {},
      unlinkedFernIds:
        raw.unlinkedFernIds && typeof raw.unlinkedFernIds === "object" ? raw.unlinkedFernIds : {},
      mappingEpoch: Number.isFinite(Number(raw.mappingEpoch)) ? Number(raw.mappingEpoch) : 0,
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
    // Preserve delete over earlier non-upsert events.
    if (existing && existing.op === "delete" && op !== "upsert") {
      return;
    }

    let maxSeq = dirtySeq;
    for (const item of Object.values(queue)) {
      if (item && typeof item.seq === "number" && item.seq > maxSeq) {
        maxSeq = item.seq;
      }
    }
    dirtySeq = maxSeq + 1;

    queue[entityId] = {
      op,
      at: Date.now(),
      seq: dirtySeq,
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
    fresh.mappingEpoch = (prev.mappingEpoch || 0) + 1;
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
      ttProjectId: ttProjectId || null,
      baseHash,
      lastSyncedAt: Date.now(),
      isRecurring: Boolean(isRecurring),
    };
    state.ttToFern[ttId] = fernId;
    if (state.unlinkedFernIds && state.unlinkedFernIds[fernId]) {
      delete state.unlinkedFernIds[fernId];
    }
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

  function isFernListSynced(state, fernListId) {
    if (!fernListId) {
      return state.inboxEnabled !== false;
    }
    return Boolean(resolveTtProjectForFernList(state, fernListId));
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
    const startEpoch = state.mappingEpoch || 0;
    const initialInboxEnabled = state.inboxEnabled !== false;
    const initialProjectEnabled = new Map(
      Object.entries(state.projects).map(([k, v]) => [k, v ? v.enabled !== false : true])
    );
    const dirtySnapshot = loadDirtyQueue();
    const processedDirtyIds = new Set();
    const skipPushFernIds = new Set();

    function checkMappingReset() {
      const latest = loadState();
      if ((latest.mappingEpoch || 0) !== startEpoch) {
        appendLog("warn", "Sync aborted because sync mapping was reset while syncing.");
        return latest;
      }
      return null;
    }

    try {
      // 1. Reconcile TickTick projects <-> Fern lists
      const remoteProjects = await api.listProjects();
      const resetAfterProjects = checkMappingReset();
      if (resetAfterProjects) {
        return { ok: false, aborted: true, reason: "mapping_reset", stats, state: resetAfterProjects };
      }

      const fernLists = fern.lists.all();
      const fernListById = new Map();
      const fernListByName = new Map();
      for (const lst of fernLists) {
        fernListById.set(lst.id, lst);
        // Never match archived or completed Fern lists when linking by name.
        if (lst.archived || lst.completedAt) continue;
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
        let fernListId =
          prev && prev.fernListId && fernListById.has(prev.fernListId)
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

      // Prune closed or deleted TickTick projects so stale checkboxes and push targets disappear.
      for (const ttPid of Object.keys(state.projects)) {
        if (!activeRemoteProjectIds.has(ttPid)) {
          delete state.projects[ttPid];
        }
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
        const pdata = await api.getProjectData(ttPid);
        if (pdata.notFound) continue;
        fetchedProjectIds.add(ttPid);
        for (const t of pdata.tasks) {
          if (t && t.id) remoteById.set(t.id, t);
        }
      }

      const resetBeforeReconcile = checkMappingReset();
      if (resetBeforeReconcile) {
        return { ok: false, aborted: true, reason: "mapping_reset", stats, state: resetBeforeReconcile };
      }

      // 3. Snapshot Fern tasks (including deleted & completed so we can detect local deletes/completions)
      let allFernTasks = [];
      const fernById = new Map();
      const fernChecklistCache = new Map();

      function refreshFernSnapshot() {
        allFernTasks = fern.tasks.list({ includeDeleted: true });
        fernById.clear();
        fernChecklistCache.clear();
        for (const t of allFernTasks) {
          fernById.set(t.id, t);
        }
      }

      function getChecklist(fernId) {
        if (!fernChecklistCache.has(fernId)) {
          fernChecklistCache.set(fernId, readFernChecklist(fernId));
        }
        return fernChecklistCache.get(fernId);
      }

      refreshFernSnapshot();

      // Prune tombstones for Fern tasks that have been deleted or purged.
      for (const fid of Object.keys(state.unlinkedFernIds)) {
        const ft = fernById.get(fid);
        if (!ft || ft.deletedAt) {
          delete state.unlinkedFernIds[fid];
        }
      }

      // 4. Phase A + B — Reconcile every existing linked task
      let localMutationsInPhaseAB = false;
      const linkedFernIds = Object.keys(state.tasks);
      for (const fernId of linkedFernIds) {
        const link = state.tasks[fernId];
        if (!link) continue;
        const localTask = fernById.get(fernId) || null;
        const remoteTask = remoteById.get(link.ttId) || null;

        try {
          // Case 1: Deleted locally in Fern
          if (!localTask || localTask.deletedAt) {
            if (allowPush) {
              if (remoteTask) {
                const targetPid = remoteTask.projectId || link.ttProjectId;
                if (targetPid) {
                  await api.deleteTask(targetPid, link.ttId);
                  remoteById.delete(link.ttId);
                  stats.deleted++;
                  appendLog("info", `↑ Deleted in TickTick: "${remoteTask.title}"`);
                }
              }
              unlinkTask(state, fernId);
              processedDirtyIds.add(fernId);
            } else if (remoteTask) {
              // pull_only: keep link & dirty queue entry and drop from remoteById so Phase C does not resurrect it.
              remoteById.delete(link.ttId);
            } else if (link.ttProjectId && fetchedProjectIds.has(link.ttProjectId)) {
              unlinkTask(state, fernId);
              processedDirtyIds.add(fernId);
            }
            continue;
          }

          // Case 2: Completed or marked Won't Do locally in Fern while still linked
          if (localTask.completed || localTask.wontDoAt) {
            if (allowPush) {
              if (remoteTask) {
                const targetPid = remoteTask.projectId || link.ttProjectId;
                if (targetPid) {
                  await api.completeTask(targetPid, link.ttId);
                  remoteById.delete(link.ttId);
                  stats.completed++;
                  appendLog(
                    "info",
                    localTask.wontDoAt && !localTask.completed
                      ? `↑ Closed (Won't Do) in TickTick: "${localTask.title}"`
                      : `↑ Completed in TickTick: "${localTask.title}"`
                  );
                }
              }
              unlinkTask(state, fernId);
              processedDirtyIds.add(fernId);
            } else if (remoteTask) {
              // pull_only: prevent Phase C resurrection while preserving pending local completion.
              remoteById.delete(link.ttId);
            } else if (link.ttProjectId && fetchedProjectIds.has(link.ttProjectId)) {
              unlinkTask(state, fernId);
              processedDirtyIds.add(fernId);
            }
            continue;
          }

          // Case 3: Local task is open, but remote vanished from open-task lists
          if (!remoteTask) {
            // Only investigate if the task's known project was actually fetched this round.
            if (!link.ttProjectId || !fetchedProjectIds.has(link.ttProjectId)) {
              continue;
            }
            const probed = await api.getTask(link.ttProjectId, link.ttId);
            if (probed && (Number(probed.status || 0) !== 0 || probed.completedTime)) {
              if (allowPull) {
                // Real Fern Store::complete_with_cascaded keeps `fernId` open with advanced
                // dueDate for recurring tasks and creates completed history snapshot `copyId`.
                // Never bind `copyId` or rebind open `fernId` to the closed `link.ttId`.
                fern.tasks.complete(fernId);
                localMutationsInPhaseAB = true;
                stats.completed++;
                appendLog("info", `↓ Completed from TickTick: "${localTask.title}"`);
                unlinkTask(state, fernId);
                skipPushFernIds.add(fernId);
                processedDirtyIds.add(fernId);
              }
            } else if (!probed) {
              if (allowPull && deletePolicy === "trash") {
                fern.tasks.delete(fernId);
                localMutationsInPhaseAB = true;
                stats.deleted++;
                appendLog("info", `↓ Moved to Trash (deleted in TickTick): "${localTask.title}"`);
                unlinkTask(state, fernId);
              } else {
                appendLog("info", `Unlinked (deleted in TickTick): "${localTask.title}"`);
                unlinkTask(state, fernId);
                skipPushFernIds.add(fernId);
                if (allowPull && deletePolicy !== "trash") {
                  state.unlinkedFernIds[fernId] = Date.now();
                }
              }
              processedDirtyIds.add(fernId);
            }
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
            if (remoteProjectId && remoteProjectId !== link.ttProjectId) {
              link.ttProjectId = remoteProjectId;
            }
            processedDirtyIds.add(fernId);
            continue;
          }

          if (localHash === remoteHash) {
            linkTask(state, fernId, link.ttId, remoteProjectId, localHash, Boolean(localNorm.repeat));
            processedDirtyIds.add(fernId);
            continue;
          }

          const localChanged = localHash !== link.baseHash;
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
            localMutationsInPhaseAB = true;
            fernById.set(fernId, updated);
            fernChecklistCache.set(fernId, remoteNorm.checklist);
            const finalHash = canonicalTaskHash(normalizeFernTask(updated, remoteNorm.checklist));
            linkTask(state, fernId, link.ttId, remoteProjectId, finalHash, Boolean(remoteNorm.repeat));
            stats.pulled++;
            appendLog("info", `↓ Updated in Fern: "${updated.title}"`);
            processedDirtyIds.add(fernId);
          } else if (action === "push") {
            // If the task was moved to an unsynced Fern list, unlink instead of pushing to a stale project.
            if (!isFernListSynced(state, localTask.listId)) {
              unlinkTask(state, fernId);
              remoteById.delete(link.ttId);
              skipPushFernIds.add(fernId);
              appendLog("info", `Unlinked "${localTask.title}" (moved to unsynced list).`);
              processedDirtyIds.add(fernId);
              continue;
            }
            const targetTtPid = resolveTtProjectForFernList(state, localTask.listId) || remoteProjectId;
            const ttParentId =
              localTask.parentId && state.tasks[localTask.parentId]
                ? state.tasks[localTask.parentId].ttId
                : null;
            const payload = fernTaskToTtPayload(
              localTask,
              localChecklist,
              targetTtPid,
              link.ttId,
              ttParentId
            );
            const updatedRemote = await api.updateTask(link.ttId, payload);
            const finalTtPid = (updatedRemote && updatedRemote.projectId) || targetTtPid;
            if (!state.inboxProjectId && localTask.listId === null && finalTtPid) {
              state.inboxProjectId = finalTtPid;
            }
            const syncedRemoteObj =
              updatedRemote && typeof updatedRemote === "object" ? updatedRemote : payload;
            const syncedNorm = normalizeTickTickTask(
              syncedRemoteObj,
              resolveFernListForTtProject(state, finalTtPid),
              syncedRemoteObj.parentId ? state.ttToFern[syncedRemoteObj.parentId] || null : null
            );
            const syncedHash = canonicalTaskHash(syncedNorm);
            linkTask(state, fernId, link.ttId, finalTtPid, syncedHash, Boolean(syncedNorm.repeat));
            stats.pushed++;
            appendLog("info", `↑ Updated in TickTick: "${localTask.title}"`);
            processedDirtyIds.add(fernId);
          } else if (!localChanged) {
            processedDirtyIds.add(fernId);
          }
        } catch (err) {
          if (isAbortingApiError(err)) {
            throw err;
          }
          stats.errors++;
          appendLog(
            "error",
            `Sync error on "${localTask ? localTask.title : fernId}": ${String(err && err.message ? err.message : err)}`
          );
        }
      }

      // Refresh Fern snapshot after Phase A/B mutations (completions, recurring dueDate advances,
      // deletions, updates) so Phase C dedup and Phase D push never read stale pre-completion data.
      if (localMutationsInPhaseAB) {
        refreshFernSnapshot();
      }

      const resetBeforePullPush = checkMappingReset();
      if (resetBeforePullPush) {
        return { ok: false, aborted: true, reason: "mapping_reset", stats, state: resetBeforePullPush };
      }

      // 5. Phase C — Pull unlinked open tasks from TickTick into Fern (with smart dedup)
      if (allowPull) {
        const unlinkedRemote = [];
        for (const [ttId, ttTask] of remoteById.entries()) {
          if (!state.ttToFern[ttId]) {
            unlinkedRemote.push(ttTask);
          }
        }

        // Build dedup index (arrays of candidates) of currently unlinked open Fern tasks grouped by listId.
        const unlinkedFernByListAndKey = new Map();
        for (const ft of allFernTasks) {
          if (ft.deletedAt || ft.completed || ft.wontDoAt || state.tasks[ft.id]) continue;
          const bucketKey = `${ft.listId || INBOX_KEY}::${dedupKey(ft.title, ft.dueDate)}`;
          let bucket = unlinkedFernByListAndKey.get(bucketKey);
          if (!bucket) {
            bucket = [];
            unlinkedFernByListAndKey.set(bucketKey, bucket);
          }
          bucket.push(ft);
        }

        const orderedRemote = topoSortTasks(unlinkedRemote, "id", "parentId");
        const toCreate = [];

        for (const ttTask of orderedRemote) {
          const ttPid = ttTask.projectId || state.inboxProjectId || null;
          const fernListId = resolveFernListForTtProject(state, ttPid);
          const fernParentId = ttTask.parentId ? state.ttToFern[ttTask.parentId] || null : null;
          const norm = normalizeTickTickTask(ttTask, fernListId, fernParentId);

          // Smart deduplication on first sync: link matching open task instead of duplicating.
          const dk = `${fernListId || INBOX_KEY}::${dedupKey(norm.title, norm.dueDate)}`;
          const bucket = unlinkedFernByListAndKey.get(dk);
          let dupIdx = -1;
          let dupLocalHash = null;
          const remoteHash = canonicalTaskHash(norm);

          if (bucket && bucket.length > 0) {
            // Prefer an exact canonical match when multiple tasks share (title, dueDate).
            for (let i = 0; i < bucket.length; i++) {
              const cand = bucket[i];
              if (state.tasks[cand.id]) continue;
              const candHash = canonicalTaskHash(normalizeFernTask(cand, getChecklist(cand.id)));
              if (candHash === remoteHash) {
                dupIdx = i;
                dupLocalHash = candHash;
                break;
              }
              if (dupIdx < 0) {
                dupIdx = i;
                dupLocalHash = candHash;
              }
            }
          }

          if (dupIdx >= 0) {
            const dup = bucket.splice(dupIdx, 1)[0];
            if (bucket.length === 0) unlinkedFernByListAndKey.delete(dk);
            // Only record localHash as baseHash when both sides already match; otherwise use
            // a sentinel baseHash so Sync #2 enters conflict resolution instead of silently
            // wiping Fern-only fields.
            const baseHash = dupLocalHash === remoteHash ? dupLocalHash : INITIAL_DEDUP_BASE_HASH;
            linkTask(
              state,
              dup.id,
              ttTask.id,
              ttPid,
              baseHash,
              Boolean(norm.repeat || dup.repeat)
            );
            stats.linked++;
            appendLog("info", `↔ Linked existing task (no duplicate): "${dup.title}"`);
          } else {
            toCreate.push({ ttTask, ttPid, norm });
          }
        }

        if (toCreate.length > 0) {
          // Buffer linkTask mutations during fern.batch and commit ONLY after SQLite commits.
          const batchPending = [];
          const batchTtToFern = new Map();

          fern.batch(() => {
            for (const entry of toCreate) {
              const fernParentId = entry.ttTask.parentId
                ? state.ttToFern[entry.ttTask.parentId] || batchTtToFern.get(entry.ttTask.parentId) || null
                : null;
              const patch = normalizedToFernPatch({ ...entry.norm, parentId: fernParentId });
              const created = fern.tasks.create(patch);
              if (fernParentId && created.parentId !== fernParentId) {
                fern.tasks.update(created.id, { parentId: fernParentId });
              }
              const fresh = fern.tasks.get(created.id) || created;
              const hash = canonicalTaskHash(normalizeFernTask(fresh, entry.norm.checklist));
              batchTtToFern.set(entry.ttTask.id, fresh.id);
              batchPending.push({
                fresh,
                checklist: entry.norm.checklist,
                ttId: entry.ttTask.id,
                ttPid: entry.ttPid,
                hash,
                isRecurring: Boolean(entry.norm.repeat),
              });
            }
          });

          for (const item of batchPending) {
            fernById.set(item.fresh.id, item.fresh);
            fernChecklistCache.set(item.fresh.id, item.checklist);
            allFernTasks.push(item.fresh);
            linkTask(state, item.fresh.id, item.ttId, item.ttPid, item.hash, item.isRecurring);
            stats.pulled++;
          }
          appendLog("info", `↓ Imported ${batchPending.length} new task(s) from TickTick.`);
        }
      }

      // 6. Phase D — Push unlinked open Fern tasks in enabled lists to TickTick
      if (allowPush) {
        const unlinkedLocal = [];
        for (const ft of allFernTasks) {
          if (
            ft.deletedAt ||
            ft.completed ||
            ft.wontDoAt ||
            state.tasks[ft.id] ||
            skipPushFernIds.has(ft.id) ||
            state.unlinkedFernIds[ft.id]
          ) {
            continue;
          }
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

        let pushedInPhaseD = 0;
        for (const ft of orderedLocal) {
          try {
            const targetTtPid = targetByFernId.get(ft.id);
            const ttParentId =
              ft.parentId && state.tasks[ft.parentId]
                ? state.tasks[ft.parentId].ttId
                : null;
            const checklist = getChecklist(ft.id);
            const payload = fernTaskToTtPayload(ft, checklist, targetTtPid, null, ttParentId);
            const created = await api.createTask(payload);
            const resolvedPid = created.projectId || targetTtPid;
            if (!state.inboxProjectId && ft.listId === null && resolvedPid) {
              state.inboxProjectId = resolvedPid;
            }
            const syncedNorm = normalizeTickTickTask(
              created,
              resolveFernListForTtProject(state, resolvedPid),
              created.parentId ? state.ttToFern[created.parentId] || null : null
            );
            const hash = canonicalTaskHash(syncedNorm);
            linkTask(state, ft.id, created.id, resolvedPid, hash, Boolean(syncedNorm.repeat || ft.repeat));
            processedDirtyIds.add(ft.id);
            stats.pushed++;
            pushedInPhaseD++;
          } catch (err) {
            if (isAbortingApiError(err)) {
              throw err;
            }
            stats.errors++;
            appendLog(
              "error",
              `↑ Push failed for "${ft.title}": ${String(err && err.message ? err.message : err)}`
            );
          }
        }
        if (pushedInPhaseD > 0) {
          appendLog("info", `↑ Pushed ${pushedInPhaseD} new task(s) to TickTick.`);
        }
      }

      // 7. Merge concurrent state toggles / resetMapping and dirty queue events before saving
      const latestState = loadState();
      if ((latestState.mappingEpoch || 0) !== startEpoch) {
        appendLog("warn", "Sync finished after mapping reset — discarded stale mapping updates.");
        return { ok: false, aborted: true, reason: "mapping_reset", stats, state: latestState };
      }

      const latestInboxEnabled = latestState.inboxEnabled !== false;
      if (latestInboxEnabled !== initialInboxEnabled) {
        state.inboxEnabled = latestInboxEnabled;
      }
      for (const [ttPid, latestMeta] of Object.entries(latestState.projects || {})) {
        if (!state.projects[ttPid]) continue;
        const latestEn = latestMeta ? latestMeta.enabled !== false : true;
        if (!initialProjectEnabled.has(ttPid) || latestEn !== initialProjectEnabled.get(ttPid)) {
          state.projects[ttPid].enabled = latestEn;
        }
      }

      state.lastSyncAt = Date.now();
      state.lastSyncSummary = stats;
      state.lastError = stats.errors > 0 ? `${stats.errors} item(s) had sync errors (see log)` : null;
      saveState(state);

      // Only delete dirty entries that were actually processed AND have not been superseded concurrently.
      const latestDirty = loadDirtyQueue();
      for (const fernId of processedDirtyIds) {
        const snap = dirtySnapshot[fernId];
        const cur = latestDirty[fernId];
        if (!cur || !snap) continue;
        if (cur.seq === snap.seq && cur.at === snap.at && cur.op === snap.op) {
          delete latestDirty[fernId];
        }
      }
      saveDirtyQueue(latestDirty);

      return { ok: true, stats, state };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      // Reload persisted state from storage so rolled-back batch links or partial in-memory
      // state are NEVER persisted on failure.
      const persisted = loadState();
      persisted.lastError = msg;
      saveState(persisted);
      appendLog("error", `Sync failed: ${msg}`);
      return { ok: false, error: msg, stats, state: persisted };
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
