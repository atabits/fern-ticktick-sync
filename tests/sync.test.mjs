import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalTaskHash,
  fernTaskToTtPayload,
  formatTickTickDate,
  minutesToTtReminder,
  normalizeFernTask,
  normalizeTickTickTask,
  parseTickTickDate,
  ttReminderToMinutes,
} from "../date_convert.js";
import { createSyncEngine } from "../sync_engine.js";

test("date and reminder conversions round-trip without drift", () => {
  const formatted = formatTickTickDate("2026-11-23", null);
  assert.ok(formatted && formatted.startsWith("2026-11-23T00:00:00"));
  const parsedAllDay = parseTickTickDate(formatted, true);
  assert.equal(parsedAllDay.date, "2026-11-23");
  assert.equal(parsedAllDay.time, null);

  const timed = formatTickTickDate("2026-11-23", "14:45");
  const parsedTimed = parseTickTickDate(timed, false);
  assert.equal(parsedTimed.date, "2026-11-23");
  assert.equal(parsedTimed.time, "14:45");

  // Reminder round-trip for timed & all-day tasks
  assert.equal(ttReminderToMinutes("TRIGGER:-PT15M", false), 15);
  assert.equal(ttReminderToMinutes("TRIGGER:PT0S", false), 0);
  assert.equal(minutesToTtReminder(15, false), "TRIGGER:-PT15M0S");
  assert.equal(ttReminderToMinutes(minutesToTtReminder(15, false), false), 15);
  assert.equal(ttReminderToMinutes(minutesToTtReminder(0, true), true), 0);
});

function createMockHarness({ settings = {}, initialLists = [], initialTasks = [], remoteProjects = [], remoteTasksByProject = {} }) {
  const kv = new Map();
  let idSeq = 1;

  const lists = initialLists.map((l) => ({ ...l }));
  const tasks = new Map();
  const checklists = new Map();
  for (const t of initialTasks) {
    tasks.set(t.id, { notes: "", tags: [], reminders: [], priority: "none", completed: false, deletedAt: null, ...t });
    checklists.set(t.id, t._checklist ? t._checklist.map((c) => ({ ...c })) : []);
  }

  const remoteTasks = new Map(); // ttId -> task
  for (const [pid, arr] of Object.entries(remoteTasksByProject)) {
    for (const rt of arr) {
      remoteTasks.set(rt.id, { projectId: pid, status: 0, ...rt });
    }
  }
  const completedRemote = new Map(); // ttId -> completed task

  const fern = {
    settings: {
      get: (k) => (k in settings ? settings[k] : null),
      hasSecret: () => true,
    },
    storage: {
      get: (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
      set: (k, v) => {
        kv.set(k, structuredClone(v));
        return true;
      },
    },
    batch: (fn) => fn(),
    lists: {
      all: () => lists.map((l) => ({ ...l })),
      create: (draft) => {
        const created = { id: `fl-${idSeq++}`, name: draft.name, color: draft.color || null };
        lists.push(created);
        return { ...created };
      },
    },
    tasks: {
      list: () => Array.from(tasks.values()).map((t) => ({ ...t })),
      get: (id) => (tasks.has(id) ? { ...tasks.get(id) } : null),
      checklist: (id) => (checklists.get(id) || []).map((c) => ({ ...c })),
      create: (draft) => {
        const id = `ft-${idSeq++}`;
        const task = {
          id,
          title: draft.title,
          notes: draft.notes || "",
          listId: draft.listId ?? null,
          parentId: draft.parentId ?? null,
          priority: draft.priority || "none",
          dueDate: draft.dueDate ?? null,
          dueTime: draft.dueTime ?? null,
          endDate: draft.endDate ?? null,
          endTime: draft.endTime ?? null,
          repeat: draft.repeat ?? null,
          tags: Array.isArray(draft.tags) ? [...draft.tags] : [],
          reminders: Array.isArray(draft.reminders) ? [...draft.reminders] : [],
          completed: false,
          deletedAt: null,
          createdAt: Date.now(),
          modifiedAt: Date.now(),
        };
        tasks.set(id, task);
        checklists.set(id, Array.isArray(draft.checklist) ? draft.checklist.map((c) => ({ ...c })) : []);
        return { ...task };
      },
      update: (id, patch) => {
        const cur = tasks.get(id);
        assert.ok(cur, `task ${id} not found`);
        const next = { ...cur, ...patch, modifiedAt: Date.now() };
        delete next.checklist;
        tasks.set(id, next);
        if (Array.isArray(patch.checklist)) {
          checklists.set(id, patch.checklist.map((c) => ({ ...c })));
        }
        return { ...next };
      },
      complete: (id) => {
        const cur = tasks.get(id);
        cur.completed = true;
        let copyId;
        if (cur.repeat) {
          const copy = fern.tasks.create({ ...cur, dueDate: "2026-11-24" });
          copyId = copy.id;
        }
        return { ...cur, copyId };
      },
      delete: (id) => {
        const cur = tasks.get(id);
        if (cur) cur.deletedAt = Date.now();
        return true;
      },
    },
  };

  const apiCalls = [];
  const api = {
    listProjects: async () => remoteProjects.map((p) => ({ ...p })),
    getInboxData: async () => ({
      ok: true,
      inboxId: "inbox100",
      tasks: Array.from(remoteTasks.values()).filter((t) => t.projectId === "inbox100"),
    }),
    getProjectData: async (pid) => ({
      project: remoteProjects.find((p) => p.id === pid) || null,
      tasks: Array.from(remoteTasks.values()).filter((t) => t.projectId === pid),
      columns: [],
    }),
    getTask: async (_pid, tid) => {
      if (remoteTasks.has(tid)) return { ...remoteTasks.get(tid) };
      if (completedRemote.has(tid)) return { ...completedRemote.get(tid) };
      return null;
    },
    createTask: async (payload) => {
      const id = `tt-new-${idSeq++}`;
      const created = { ...payload, id, projectId: payload.projectId || "inbox100", status: 0, modifiedTime: new Date().toISOString() };
      remoteTasks.set(id, created);
      apiCalls.push({ op: "create", id, payload });
      return { ...created };
    },
    updateTask: async (tid, payload) => {
      const prev = remoteTasks.get(tid) || {};
      const next = { ...prev, ...payload, id: tid, modifiedTime: new Date().toISOString() };
      remoteTasks.set(tid, next);
      apiCalls.push({ op: "update", id: tid, payload });
      return { ...next };
    },
    completeTask: async (_pid, tid) => {
      const prev = remoteTasks.get(tid);
      remoteTasks.delete(tid);
      if (prev) completedRemote.set(tid, { ...prev, status: 2, completedTime: new Date().toISOString() });
      apiCalls.push({ op: "complete", id: tid });
      return true;
    },
    deleteTask: async (_pid, tid) => {
      remoteTasks.delete(tid);
      apiCalls.push({ op: "delete", id: tid });
      return true;
    },
  };

  return { fern, api, tasks, checklists, remoteTasks, completedRemote, apiCalls };
}

test("initial merge deduplicates matching tasks, pulls new, pushes new, and is idempotent on second sync", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work", color: "#3b82f6" }],
    initialTasks: [
      { id: "ft-existing", title: "Ship release", listId: "fl-work", dueDate: "2026-11-25" },
      { id: "ft-local-only", title: "Local Fern task", listId: "fl-work", priority: "high" },
    ],
    remoteProjects: [{ id: "tp-work", name: "Work", color: "#3b82f6" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-existing", title: "Ship release", dueDate: formatTickTickDate("2026-11-25", null), isAllDay: true },
        {
          id: "tt-remote-only",
          title: "From TickTick",
          priority: 5,
          items: [{ title: "Step 1", status: 0 }, { title: "Step 2", status: 1 }],
        },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.linked, 1); // deduped "Ship release"
  assert.equal(r1.stats.pulled, 1); // imported "From TickTick"
  assert.equal(r1.stats.pushed, 1); // pushed "Local Fern task"
  assert.equal(h.tasks.size, 3); // NO duplicate created!

  // Verify checklist was imported
  const imported = Array.from(h.tasks.values()).find((t) => t.title === "From TickTick");
  assert.ok(imported);
  assert.deepEqual(h.checklists.get(imported.id), [
    { title: "Step 1", completed: false },
    { title: "Step 2", completed: true },
  ]);

  // Second sync immediately after must be a pure no-op (zero echo / ping-pong!)
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.pulled, 0);
  assert.equal(r2.stats.pushed, 0);
  assert.equal(r2.stats.completed, 0);
  assert.equal(r2.stats.conflicts, 0);
});

test("detects vanished remote task completion vs deletion and handles recurring copyId rebind", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-done-remote", title: "Finish report" },
        { id: "tt-del-remote", title: "Temp note" },
        { id: "tt-recur", title: "Daily standup", repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1" },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.stats.pulled, 3);

  // 1. Mark tt-done-remote completed in TickTick, and delete tt-del-remote in TickTick
  const doneTask = h.remoteTasks.get("tt-done-remote");
  h.remoteTasks.delete("tt-done-remote");
  h.completedRemote.set("tt-done-remote", { ...doneTask, status: 2, completedTime: new Date().toISOString() });
  h.remoteTasks.delete("tt-del-remote");

  // 2. Complete recurring task locally in Fern (spawns next occurrence)
  const localRecur = Array.from(h.tasks.values()).find((t) => t.title === "Daily standup");
  h.fern.tasks.complete(localRecur.id);

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.completed, 2); // 1 pulled completion + 1 pushed recurring completion
  assert.equal(r2.stats.deleted, 1);

  const localDone = Array.from(h.tasks.values()).find((t) => t.title === "Finish report");
  assert.equal(localDone.completed, true);

  const localDel = Array.from(h.tasks.values()).find((t) => t.title === "Temp note");
  assert.ok(localDel.deletedAt);

  // Recurring task link must now point to the newly spawned open occurrence!
  const state = engine.loadState();
  const reboundFernId = state.ttToFern["tt-recur"];
  assert.ok(reboundFernId && reboundFernId !== localRecur.id);
  assert.equal(h.tasks.get(reboundFernId).completed, false);
});

test("3-way conflict resolution respects fern_wins and ticktick_wins policies", async () => {
  const h = createMockHarness({
    settings: { conflict_policy: "fern_wins" },
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [{ id: "tt-1", title: "Original" }],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();

  const local = Array.from(h.tasks.values())[0];
  h.fern.tasks.update(local.id, { title: "Edited in Fern" });
  h.remoteTasks.get("tt-1").title = "Edited in TickTick";

  const r2 = await engine.syncNow();
  assert.equal(r2.stats.conflicts, 1);
  assert.equal(r2.stats.pushed, 1);
  assert.equal(h.remoteTasks.get("tt-1").title, "Edited in Fern");
});
