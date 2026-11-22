import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  canonicalTaskHash,
  fernTaskToTtPayload,
  formatRepeatForTickTick,
  formatTickTickDate,
  minutesToTtReminder,
  normalizeChecklist,
  normalizeFernTask,
  normalizeRepeat,
  normalizeTickTickTask,
  parseTickTickDate,
  shiftIsoDate,
  ttReminderToMinutes,
} from "../date_convert.js";
import { createSyncEngine, INBOX_KEY } from "../sync_engine.js";
import { createTickTickClient } from "../ticktick_api.js";
import worker from "../oauth-worker/worker.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createMockHarness({
  settings = {},
  initialLists = [],
  initialTasks = [],
  remoteProjects = [],
  remoteTasksByProject = {},
  inboxId = "inbox100",
  failBatchAtTitle = null,
}) {
  const kv = new Map();
  let idSeq = 1;

  const lists = initialLists.map((l) => ({ archived: false, completedAt: null, ...l }));
  const tasks = new Map();
  const checklists = new Map();
  for (const t of initialTasks) {
    tasks.set(t.id, {
      notes: "",
      tags: [],
      reminders: [],
      priority: "none",
      completed: false,
      deletedAt: null,
      wontDoAt: null,
      createdAt: 1_700_000_000_000,
      modifiedAt: 1_700_000_000_000,
      ...t,
    });
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
    // Real transactional rollback semantics matching Fern SQLite SAVEPOINT in fern.batch.
    batch: (fn) => {
      const snapTasks = structuredClone(tasks);
      const snapChecklists = structuredClone(checklists);
      const snapSeq = idSeq;
      try {
        return fn();
      } catch (err) {
        tasks.clear();
        for (const [k, v] of snapTasks.entries()) tasks.set(k, v);
        checklists.clear();
        for (const [k, v] of snapChecklists.entries()) checklists.set(k, v);
        idSeq = snapSeq;
        throw err;
      }
    },
    lists: {
      all: () => lists.map((l) => ({ ...l })),
      create: (draft) => {
        const created = {
          id: `fl-${idSeq++}`,
          name: draft.name,
          color: draft.color || null,
          archived: false,
          completedAt: null,
        };
        lists.push(created);
        return { ...created };
      },
    },
    tasks: {
      list: () => Array.from(tasks.values()).map((t) => ({ ...t })),
      get: (id) => (tasks.has(id) ? { ...tasks.get(id) } : null),
      checklist: (id) => (checklists.get(id) || []).map((c) => ({ ...c })),
      create: (draft) => {
        if (failBatchAtTitle && draft.title === failBatchAtTitle) {
          throw new Error(`Simulated SQLite batch failure on "${draft.title}"`);
        }
        const id = `ft-${idSeq++}`;
        const now = Date.now();
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
          repeat: draft.repeat ? normalizeRepeat(draft.repeat) : null,
          tags: Array.isArray(draft.tags) ? [...draft.tags] : [],
          reminders: Array.isArray(draft.reminders) ? [...draft.reminders] : [],
          completed: false,
          deletedAt: null,
          wontDoAt: null,
          createdAt: now,
          modifiedAt: now,
        };
        tasks.set(id, task);
        checklists.set(id, Array.isArray(draft.checklist) ? draft.checklist.map((c) => ({ ...c })) : []);
        return { ...task };
      },
      update: (id, patch) => {
        const cur = tasks.get(id);
        assert.ok(cur, `task ${id} not found`);
        const next = { ...cur, ...patch, modifiedAt: Date.now() };
        if ("repeat" in patch) {
          next.repeat = patch.repeat ? normalizeRepeat(patch.repeat) : null;
        }
        delete next.checklist;
        tasks.set(id, next);
        if (Array.isArray(patch.checklist)) {
          checklists.set(id, patch.checklist.map((c) => ({ ...c })));
        }
        return { ...next };
      },
      // Exact semantics of real Fern Store::complete_with_cascaded (crates/core/src/store.rs:1936-2019):
      // For recurring tasks with a dueDate, inserts completed history snapshot as `copyId`
      // (completed=true, repeat=null) and keeps original `id` OPEN with advanced dueDate.
      complete: (id) => {
        const cur = tasks.get(id);
        assert.ok(cur, `task ${id} not found`);
        if (cur.repeat && cur.dueDate) {
          const copy = fern.tasks.create({
            ...cur,
            repeat: null,
            checklist: (checklists.get(id) || []).map((c) => ({ ...c })),
          });
          const copyTask = tasks.get(copy.id);
          copyTask.completed = true;
          copyTask.completedAt = Date.now();

          cur.dueDate = shiftIsoDate(cur.dueDate, 1) || "2026-11-24";
          if (cur.endDate) cur.endDate = shiftIsoDate(cur.endDate, 1) || cur.endDate;
          cur.modifiedAt = Date.now();
          checklists.set(
            id,
            (checklists.get(id) || []).map((c) => ({ ...c, completed: false }))
          );
          return { ...cur, copyId: copy.id };
        }
        cur.completed = true;
        cur.completedAt = Date.now();
        cur.modifiedAt = Date.now();
        return { ...cur };
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
      inboxId,
      tasks: inboxId ? Array.from(remoteTasks.values()).filter((t) => t.projectId === inboxId) : [],
    }),
    getProjectData: async (pid) => ({
      notFound: false,
      project: remoteProjects.find((p) => p.id === pid) || null,
      tasks: Array.from(remoteTasks.values()).filter((t) => t.projectId === pid),
      columns: [],
    }),
    getTask: async (pid, tid) => {
      apiCalls.push({ op: "getTask", pid, tid });
      if (remoteTasks.has(tid)) return { ...remoteTasks.get(tid) };
      if (completedRemote.has(tid)) return { ...completedRemote.get(tid) };
      return null;
    },
    createTask: async (payload) => {
      const id = `tt-new-${idSeq++}`;
      const created = {
        ...payload,
        id,
        projectId: payload.projectId || inboxId || "inbox100",
        status: 0,
        modifiedTime: new Date().toISOString(),
      };
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
    completeTask: async (pid, tid) => {
      const prev = remoteTasks.get(tid);
      remoteTasks.delete(tid);
      if (prev) completedRemote.set(tid, { ...prev, status: 2, completedTime: new Date().toISOString() });
      apiCalls.push({ op: "complete", pid, id: tid });
      return true;
    },
    deleteTask: async (pid, tid) => {
      remoteTasks.delete(tid);
      apiCalls.push({ op: "delete", pid, id: tid });
      return true;
    },
  };

  return { fern, api, lists, tasks, checklists, remoteTasks, completedRemote, apiCalls };
}

test("date, multi-day all-day, isAllDay inference, reminder, repeat, and checklist conversions", () => {
  const formatted = formatTickTickDate("2026-11-23", null);
  assert.ok(formatted && formatted.startsWith("2026-11-23T00:00:00"));
  const parsedAllDay = parseTickTickDate(formatted, true);
  assert.equal(parsedAllDay.date, "2026-11-23");
  assert.equal(parsedAllDay.time, null);

  const timed = formatTickTickDate("2026-11-23", "14:45");
  const parsedTimed = parseTickTickDate(timed, false);
  assert.equal(parsedTimed.date, "2026-11-23");
  assert.equal(parsedTimed.time, "14:45");

  // Multi-day all-day exclusive midnight convention (matches fern_core::import)
  const ttMulti = {
    title: "Conference",
    isAllDay: true,
    startDate: "2026-11-23T00:00:00+0000",
    dueDate: "2026-11-26T00:00:00+0000",
  };
  const normMulti = normalizeTickTickTask(ttMulti);
  assert.equal(normMulti.dueDate, "2026-11-23");
  assert.equal(normMulti.endDate, "2026-11-25");
  assert.equal(normMulti.dueTime, null);

  // Round-trip back to TickTick adds +1 exclusive day
  const pushedMulti = fernTaskToTtPayload(
    { title: "Conference", dueDate: "2026-11-23", endDate: "2026-11-25" },
    [],
    "tp-1"
  );
  assert.equal(parseTickTickDate(pushedMulti.startDate, true).date, "2026-11-23");
  assert.equal(parseTickTickDate(pushedMulti.dueDate, true).date, "2026-11-26");
  assert.equal(
    canonicalTaskHash(normalizeTickTickTask(pushedMulti)),
    canonicalTaskHash(normalizeFernTask({ title: "Conference", dueDate: "2026-11-23", endDate: "2026-11-25" }))
  );

  // Single-day exclusive midnight (Nov 23 .. Nov 24) normalizes to single day with endDate=null
  const normSingleExcl = normalizeTickTickTask({
    title: "One day",
    isAllDay: true,
    startDate: "2026-11-23T00:00:00+0000",
    dueDate: "2026-11-24T00:00:00+0000",
  });
  assert.equal(normSingleExcl.dueDate, "2026-11-23");
  assert.equal(normSingleExcl.endDate, null);

  // Omitted isAllDay with non-midnight time must NOT drop time
  const normOmittedTimed = normalizeTickTickTask({
    title: "Dentist",
    dueDate: formatTickTickDate("2026-11-23", "15:30"),
  });
  assert.equal(normOmittedTimed.dueDate, "2026-11-23");
  assert.equal(normOmittedTimed.dueTime, "15:30");

  // Reminder conversions, TRIGGER;RELATED=START:, malformed rejections, deduplication
  assert.equal(ttReminderToMinutes("TRIGGER:-PT15M", false), 15);
  assert.equal(ttReminderToMinutes("TRIGGER;RELATED=START:-PT15M", false), 15);
  assert.equal(ttReminderToMinutes("TRIGGER:PT0S", false), 0);
  assert.equal(ttReminderToMinutes("TRIGGER:PTH", false), null);
  assert.equal(ttReminderToMinutes("TRIGGER:-PT15", false), null);
  assert.equal(ttReminderToMinutes("TRIGGER:PT", false), null);
  assert.equal(ttReminderToMinutes("TRIGGER:P", false), null);
  assert.equal(ttReminderToMinutes("TRIGGER:PD", false), null);
  assert.equal(minutesToTtReminder(15, false), "TRIGGER:-PT15M0S");
  assert.equal(ttReminderToMinutes(minutesToTtReminder(15, false), false), 15);
  assert.equal(ttReminderToMinutes(minutesToTtReminder(0, true), true), 0);

  const dupRem = normalizeTickTickTask({
    title: "Dup reminders",
    isAllDay: false,
    dueDate: formatTickTickDate("2026-11-23", "10:00"),
    reminders: ["TRIGGER:-PT15M", "TRIGGER;RELATED=START:-PT15M", "TRIGGER:PTH"],
  });
  assert.deepEqual(dupRem.reminders, [15]);

  // Repeat normalization: INTERVAL=1 canonicalization, ERULE/LUNAR preservation, invalid rejection
  assert.equal(normalizeRepeat("RRULE:FREQ=DAILY"), "FREQ=DAILY;INTERVAL=1");
  assert.equal(normalizeRepeat("RRULE:FREQ=DAILY;INTERVAL=1;WKST=SU;COUNT=5"), "FREQ=DAILY;INTERVAL=1");
  assert.equal(normalizeRepeat("FREQ=DAILY;INTERVAL=1"), "FREQ=DAILY;INTERVAL=1");
  assert.equal(normalizeRepeat("ERULE:NAME=FORGETTINGCURVE;CYCLE=2"), "ERULE:NAME=FORGETTINGCURVE;CYCLE=2");
  assert.equal(normalizeRepeat("LUNAR:FREQ=YEARLY;INTERVAL=1"), "LUNAR:FREQ=YEARLY;INTERVAL=1");
  assert.equal(normalizeRepeat("ERULE:NAME=UNKNOWN"), null);
  assert.equal(normalizeRepeat("RRULE:FREQ=HOURLY;INTERVAL=2"), null);
  assert.equal(formatRepeatForTickTick("FREQ=DAILY;INTERVAL=1"), "RRULE:FREQ=DAILY;INTERVAL=1");
  assert.equal(formatRepeatForTickTick("ERULE:NAME=FORGETTINGCURVE;CYCLE=2"), "ERULE:NAME=FORGETTINGCURVE;CYCLE=2");
  assert.equal(formatRepeatForTickTick("LUNAR:FREQ=YEARLY;INTERVAL=1"), "LUNAR:FREQ=YEARLY;INTERVAL=1");

  // Checklist sorting by sortOrder
  const sortedChecklist = normalizeChecklist([
    { title: "Third", status: 0, sortOrder: 3000 },
    { title: "First", status: 1, sortOrder: 1000 },
    { title: "Second", status: 0, sortOrder: 2000 },
  ]);
  assert.deepEqual(sortedChecklist, [
    { title: "First", completed: true },
    { title: "Second", completed: false },
    { title: "Third", completed: false },
  ]);
});

test("H36: timezone and DST edge cases across America/New_York and America/Havana", () => {
  const script = `
    import assert from "node:assert/strict";
    import { parseTickTickDate, formatTickTickDate } from "./date_convert.js";
    const tz = process.env.TZ;
    if (tz === "America/New_York") {
      // Plain YYYY-MM-DD and UTC-midnight all-day must NOT shift -1 day in UTC-5
      assert.equal(parseTickTickDate("2026-11-23", true).date, "2026-11-23");
      assert.equal(parseTickTickDate("2026-11-23", false).date, "2026-11-23");
      assert.equal(parseTickTickDate("2026-11-23T00:00:00+0000", true).date, "2026-11-23");
      // Winter EST (-0500) vs Summer EDT (-0400) computed at target date
      assert.ok(formatTickTickDate("2026-01-15", "14:00").endsWith("-0500"));
      assert.ok(formatTickTickDate("2026-07-15", "14:00").endsWith("-0400"));
      // Spring-forward nonexistent 02:30 formats consistent local instant (never rolled backwards to 01:30)
      const spring = formatTickTickDate("2026-03-08", "02:30");
      const back = parseTickTickDate(spring, false);
      assert.equal(back.date, "2026-03-08");
      assert.notEqual(back.time, "01:30");
    } else if (tz === "America/Havana") {
      // Midnight DST gap on 2026-03-08 must NOT shift back to 2026-03-07
      const havana = formatTickTickDate("2026-03-08", null);
      const parsed = parseTickTickDate(havana, true);
      assert.equal(parsed.date, "2026-03-08");
    }
  `;
  for (const tz of ["America/New_York", "America/Havana"]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, TZ: tz },
      stdio: "pipe",
    });
  }
});

test("initial merge deduplicates matching tasks, pulls new, pushes new, and is idempotent on second sync", async () => {
  const h = createMockHarness({
    initialLists: [
      { id: "fl-work-archived", name: "Work", archived: true },
      { id: "fl-work", name: "Work", color: "#3b82f6" },
    ],
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
          repeatFlag: "RRULE:FREQ=DAILY", // omits INTERVAL=1 — must NOT loop on Sync #2!
          items: [
            { title: "Step 2", status: 1, sortOrder: 2000 },
            { title: "Step 1", status: 0, sortOrder: 1000 },
          ],
        },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.linked, 1);
  assert.equal(r1.stats.pulled, 1);
  assert.equal(r1.stats.pushed, 1);
  assert.equal(h.tasks.size, 3);
  // Matched active fl-work, NOT archived fl-work-archived (L18)
  assert.equal(engine.loadState().projects["tp-work"].fernListId, "fl-work");

  // Verify checklist was imported in sortOrder order
  const imported = Array.from(h.tasks.values()).find((t) => t.title === "From TickTick");
  assert.ok(imported);
  assert.deepEqual(h.checklists.get(imported.id), [
    { title: "Step 1", completed: false },
    { title: "Step 2", completed: true },
  ]);

  // Second sync immediately after must be a pure no-op (even with RRULE omitting INTERVAL=1!)
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.pulled, 0);
  assert.equal(r2.stats.pushed, 0);
  assert.equal(r2.stats.completed, 0);
  assert.equal(r2.stats.conflicts, 0);
});

test("C10: Phase C fern.batch rollback never persists phantom links or deletes TickTick tasks on next sync", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-1", title: "Good task 1" },
        { id: "tt-2", title: "Boom task 2" },
      ],
    },
    failBatchAtTitle: "Boom task 2",
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Boom task 2/);
  // Batch rolled back all Fern creations AND persisted state has ZERO phantom links!
  assert.equal(h.tasks.size, 0);
  assert.deepEqual(engine.loadState().tasks, {});
  assert.deepEqual(engine.loadState().ttToFern, {});

  // Even after the error clears on a later sync, tt-1 must NEVER be deleted in TickTick!
  h.remoteTasks.get("tt-2").title = "Recovered task 2";
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.deleted, 0);
  assert.equal(r2.stats.pulled, 2);
  assert.equal(h.apiCalls.filter((c) => c.op === "delete").length, 0);
  assert.ok(h.remoteTasks.has("tt-1"));
  assert.ok(h.remoteTasks.has("tt-2"));
});

test("C11: recurring task completion matches real Fern complete_with_cascaded without duplicates or closed-ttId rebind", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-done-remote", title: "Finish report" },
        { id: "tt-del-remote", title: "Temp note" },
        {
          id: "tt-recur-remote",
          title: "Remote daily",
          dueDate: formatTickTickDate("2026-11-23", null),
          isAllDay: true,
          repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        },
        {
          id: "tt-recur-local",
          title: "Local daily",
          dueDate: formatTickTickDate("2026-11-23", null),
          isAllDay: true,
          repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.stats.pulled, 4);

  const localRecurRemote = Array.from(h.tasks.values()).find((t) => t.title === "Remote daily");
  const localRecurLocal = Array.from(h.tasks.values()).find((t) => t.title === "Local daily");

  // 1. Complete tt-done-remote and delete tt-del-remote in TickTick
  const doneTask = h.remoteTasks.get("tt-done-remote");
  h.remoteTasks.delete("tt-done-remote");
  h.completedRemote.set("tt-done-remote", { ...doneTask, status: 2, completedTime: new Date().toISOString() });
  h.remoteTasks.delete("tt-del-remote");

  // 2. Complete tt-recur-remote in TickTick (closed ttId + TickTick spawns next occurrence tt-recur-remote-2)
  const recurRemote = h.remoteTasks.get("tt-recur-remote");
  h.remoteTasks.delete("tt-recur-remote");
  h.completedRemote.set("tt-recur-remote", { ...recurRemote, status: 2, completedTime: new Date().toISOString() });
  h.remoteTasks.set("tt-recur-remote-2", {
    id: "tt-recur-remote-2",
    projectId: "tp-work",
    title: "Remote daily",
    dueDate: formatTickTickDate("2026-11-24", null),
    isAllDay: true,
    repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
    status: 0,
  });

  // 3. Complete localRecurLocal in Fern (real complete_with_cascaded keeps same ID open with advanced dueDate + completed copyId)
  const localCompRes = h.fern.tasks.complete(localRecurLocal.id);
  assert.ok(localCompRes.copyId);
  assert.equal(h.tasks.get(localRecurLocal.id).completed, false);
  assert.equal(h.tasks.get(localRecurLocal.id).dueDate, "2026-11-24");
  assert.equal(h.tasks.get(localCompRes.copyId).completed, true);

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.completed, 2); // Finish report + Remote daily pulled completions
  assert.equal(r2.stats.deleted, 1); // Temp note
  assert.equal(r2.stats.linked, 1); // Remote daily open fernId linked to tt-recur-remote-2!
  assert.equal(r2.stats.pushed, 1); // Local daily updated dueDate pushed to TickTick!

  // Original Remote daily fernId stayed open with advanced dueDate and is linked to tt-recur-remote-2 (NOT closed tt-recur-remote and NOT copyId!)
  const state = engine.loadState();
  assert.equal(state.ttToFern["tt-recur-remote"], undefined);
  assert.equal(state.ttToFern["tt-recur-remote-2"], localRecurRemote.id);
  assert.equal(h.tasks.get(localRecurRemote.id).completed, false);
  assert.equal(h.tasks.get(localRecurRemote.id).dueDate, "2026-11-24");

  // Local daily pushed its advanced dueDate cleanly without creating duplicates
  assert.equal(parseTickTickDate(h.remoteTasks.get("tt-recur-local").dueDate, true).date, "2026-11-24");
  assert.equal(h.apiCalls.filter((c) => c.op === "create").length, 0);

  // Sync #3 must be a pure no-op (no infinite re-completion loop!)
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(r3.stats.pulled, 0);
  assert.equal(r3.stats.pushed, 0);
  assert.equal(r3.stats.completed, 0);
});

test("C12: clearing fields in Fern sends explicit clears to TickTick and is NOT reverted on next sync", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-parent", title: "Parent" },
        {
          id: "tt-rich",
          title: "Rich task",
          content: "Body notes",
          desc: "Checklist desc",
          parentId: "tt-parent",
          dueDate: formatTickTickDate("2026-11-25", "10:00"),
          startDate: formatTickTickDate("2026-11-25", "10:00"),
          isAllDay: false,
          repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1",
          tags: ["urgent", "work"],
          reminders: ["TRIGGER:-PT15M0S"],
          items: [{ title: "Subitem 1", status: 0, sortOrder: 1000 }],
        },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();

  const local = Array.from(h.tasks.values()).find((t) => t.title === "Rich task");
  assert.ok(local);

  // Clear every optional field in Fern
  h.fern.tasks.update(local.id, {
    notes: "",
    dueDate: null,
    dueTime: null,
    endDate: null,
    endTime: null,
    repeat: null,
    tags: [],
    reminders: [],
    checklist: [],
    parentId: null,
  });

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.pushed, 1);

  const updateCall = h.apiCalls.find((c) => c.op === "update" && c.id === "tt-rich");
  assert.ok(updateCall);
  assert.equal(updateCall.payload.dueDate, null);
  assert.equal(updateCall.payload.startDate, null);
  assert.equal(updateCall.payload.repeatFlag, "");
  assert.deepEqual(updateCall.payload.tags, []);
  assert.deepEqual(updateCall.payload.reminders, []);
  assert.deepEqual(updateCall.payload.items, []);
  assert.equal(updateCall.payload.parentId, null);
  assert.equal(updateCall.payload.content, "");
  assert.equal(updateCall.payload.desc, "");

  // Sync #3 must be a no-op and Fern's cleared fields must stay cleared!
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(r3.stats.pulled, 0);
  assert.equal(r3.stats.pushed, 0);
  const after = h.tasks.get(local.id);
  assert.equal(after.notes, "");
  assert.equal(after.dueDate, null);
  assert.equal(after.repeat, null);
  assert.deepEqual(after.tags, []);
  assert.deepEqual(after.reminders, []);
  assert.deepEqual(h.checklists.get(local.id), []);
  assert.equal(after.parentId, null);
});

test("H36: concurrent dirty events, toggleProjectEnabled, and resetMapping are preserved during async sync", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    initialTasks: [{ id: "ft-1", title: "Task 1", listId: "fl-work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: { "tp-work": [] },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();

  // Queue initial dirty event on ft-1, then inject concurrent dirty event + project toggle mid-sync
  engine.enqueueLocalEvent("task.updated", "ft-1", { listId: "fl-work" });
  const origListProjects = h.api.listProjects;
  h.api.listProjects = async () => {
    const res = await origListProjects();
    // Concurrent edits arriving WHILE syncNow() is awaiting network I/O:
    engine.enqueueLocalEvent("task.updated", "ft-1", { listId: "fl-work" });
    engine.enqueueLocalEvent("task.created", "ft-brand-new", { listId: "fl-work" });
    engine.toggleProjectEnabled("tp-work", false);
    engine.toggleProjectEnabled(INBOX_KEY, false);
    return res;
  };

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);

  // Concurrent dirty events MUST survive (both superseded ft-1 and brand-new ft-brand-new)
  const dirtyAfter = engine.loadDirtyQueue();
  assert.ok(dirtyAfter["ft-1"], "concurrent update to ft-1 must not be clobbered");
  assert.ok(dirtyAfter["ft-brand-new"], "concurrent new event must not be clobbered");

  // Concurrent list toggles MUST survive
  const stateAfter = engine.loadState();
  assert.equal(stateAfter.projects["tp-work"].enabled, false);
  assert.equal(stateAfter.inboxEnabled, false);

  // Now test concurrent resetMapping() during syncNow()
  h.api.listProjects = async () => {
    const res = await origListProjects();
    engine.resetMapping();
    return res;
  };
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, false);
  assert.equal(r3.aborted, true);
  assert.equal(r3.reason, "mapping_reset");
  assert.deepEqual(engine.loadState().tasks, {});
  assert.deepEqual(engine.loadState().ttToFern, {});
});

test("H36: pull_only does not resurrect locally completed or deleted tasks as duplicates", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-comp", title: "Complete locally" },
        { id: "tt-del", title: "Delete locally" },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();
  assert.equal(h.tasks.size, 2);

  const tComp = Array.from(h.tasks.values()).find((t) => t.title === "Complete locally");
  const tDel = Array.from(h.tasks.values()).find((t) => t.title === "Delete locally");
  h.fern.tasks.complete(tComp.id);
  h.fern.tasks.delete(tDel.id);
  engine.enqueueLocalEvent("task.completed", tComp.id, tComp);
  engine.enqueueLocalEvent("task.deleted", tDel.id, tDel);

  // Pull-only sync must NOT create duplicates and must preserve links & dirty queue
  const rPull = await engine.syncNow({ direction: "pull_only" });
  assert.equal(rPull.ok, true);
  assert.equal(rPull.stats.pulled, 0);
  assert.equal(h.tasks.size, 2);
  assert.ok(engine.loadState().tasks[tComp.id]);
  assert.ok(engine.loadState().tasks[tDel.id]);
  assert.ok(engine.loadDirtyQueue()[tComp.id]);
  assert.ok(engine.loadDirtyQueue()[tDel.id]);

  // Later two-way sync still pushes those pending local completion & deletion!
  const rPush = await engine.syncNow({ direction: "two_way" });
  assert.equal(rPush.ok, true);
  assert.equal(rPush.stats.completed, 1);
  assert.equal(rPush.stats.deleted, 1);
});

test("H36: initial dedup sentinel baseHash preserves Fern-only fields via conflict policy on Sync #2", async () => {
  const h = createMockHarness({
    settings: { conflict_policy: "fern_wins" },
    initialLists: [{ id: "fl-work", name: "Work" }],
    initialTasks: [
      {
        id: "ft-1",
        title: "Shared title",
        listId: "fl-work",
        dueDate: "2026-11-25",
        notes: "Critical Fern-only notes",
        priority: "high",
        tags: ["fern-tag"],
      },
      {
        id: "ft-2",
        title: "Shared title",
        listId: "fl-work",
        dueDate: "2026-11-25",
        notes: "Second same-key task",
      },
    ],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-1", title: "Shared title", dueDate: formatTickTickDate("2026-11-25", null), isAllDay: true },
        {
          id: "tt-2",
          title: "Shared title",
          content: "Second same-key task",
          dueDate: formatTickTickDate("2026-11-25", null),
          isAllDay: true,
        },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.linked, 2); // Both same-key candidates matched cleanly!
  assert.equal(h.tasks.size, 2);

  // Sync #2 enters conflict resolution (fern_wins) instead of wiping Fern-only notes/priority/tags!
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.conflicts, 1);
  assert.equal(r2.stats.pushed, 1);
  assert.equal(h.tasks.get("ft-1").notes, "Critical Fern-only notes");
  assert.equal(h.tasks.get("ft-1").priority, "high");
  assert.deepEqual(h.tasks.get("ft-1").tags, ["fern-tag"]);
  assert.equal(h.remoteTasks.get("tt-1").content, "Critical Fern-only notes");
});

test("H36: Won't Do tasks are not pushed as open tasks; delete_policy='unlink' does not resurrect", async () => {
  const h = createMockHarness({
    settings: { delete_policy: "unlink" },
    initialLists: [{ id: "fl-work", name: "Work" }],
    initialTasks: [
      { id: "ft-wontdo", title: "Abandoned idea", listId: "fl-work", wontDoAt: Date.now() },
      { id: "ft-keep", title: "Keep if remotely deleted", listId: "fl-work" },
    ],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: { "tp-work": [] },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.pushed, 1); // Only ft-keep pushed; ft-wontdo skipped!
  assert.equal(h.remoteTasks.size, 1);

  // Delete ft-keep in TickTick
  const ttId = engine.loadState().tasks["ft-keep"].ttId;
  h.remoteTasks.delete(ttId);

  // Sync #2: must unlink ft-keep WITHOUT deleting in Fern AND WITHOUT re-pushing in same sync!
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.deleted, 0);
  assert.equal(r2.stats.pushed, 0);
  assert.equal(h.tasks.get("ft-keep").deletedAt, null);
  assert.equal(h.remoteTasks.size, 0);

  // Sync #3: tombstone prevents resurrecting in future syncs too!
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(r3.stats.pushed, 0);
  assert.equal(h.remoteTasks.size, 0);
});

test("M11 & M12: non-synced dirty edit causes zero conflicts; stale project pruned; null ttProjectId & unsynced list move safe", async () => {
  const h = createMockHarness({
    settings: { conflict_policy: "fern_wins" },
    initialLists: [
      { id: "fl-work", name: "Work" },
      { id: "fl-local-only", name: "Private Local" },
    ],
    remoteProjects: [
      { id: "tp-work", name: "Work" },
      { id: "tp-temp", name: "Temp Project" },
    ],
    remoteTasksByProject: {
      "tp-work": [{ id: "tt-1", title: "Original" }],
      "tp-temp": [],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();
  const local = Array.from(h.tasks.values())[0];

  // M11: dirtyEntry exists (e.g., non-synced field edited in Fern), localHash === baseHash, remote title changed
  engine.enqueueLocalEvent("task.updated", local.id, local);
  h.remoteTasks.get("tt-1").title = "Remote Edited";

  // M12: tp-temp is deleted in TickTick
  h.api.listProjects = async () => [{ id: "tp-work", name: "Work" }];

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.conflicts, 0); // NO spurious conflict!
  assert.equal(r2.stats.pulled, 1);
  assert.equal(h.tasks.get(local.id).title, "Remote Edited");
  assert.equal(engine.loadState().projects["tp-temp"], undefined); // pruned!

  // M12: Move linked Fern task to unsynced list fl-local-only -> unlinks cleanly instead of reverting
  h.fern.tasks.update(local.id, { listId: "fl-local-only" });
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(h.tasks.get(local.id).listId, "fl-local-only");
  assert.equal(engine.loadState().tasks[local.id], undefined);

  // M12: Null link.ttProjectId never probes /project/null/task/... or Trashes task
  const st = engine.loadState();
  st.tasks[local.id] = {
    ttId: "tt-orphan",
    ttProjectId: null,
    baseHash: "abc",
    lastSyncedAt: Date.now(),
    isRecurring: false,
  };
  st.ttToFern["tt-orphan"] = local.id;
  h.fern.storage.set("tt_sync_state_v1", st);
  h.apiCalls.length = 0;

  const r4 = await engine.syncNow();
  assert.equal(r4.ok, true);
  assert.equal(h.apiCalls.filter((c) => c.op === "getTask").length, 0);
  assert.equal(h.tasks.get(local.id).deletedAt, null);
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

test("H36 & M13: ticktick_api coalesces concurrent 401 refreshes, supports OFFICIAL_OAUTH, clears expired tokens, rejects 404 writes, guards JSON.parse, enforces 429 cooldown", async () => {
  const secrets = new Set(["access_token", "refresh_token"]);
  let refreshCalls = [];
  let fetchCount = 0;
  let tokenRefreshed = false;
  let expiredEvents = [];

  const mockFern = {
    settings: {
      get: () => "", // empty personal client_id — OFFICIAL_OAUTH must still work!
      hasSecret: (k) => secrets.has(k),
    },
    oauth: {
      refresh: async (opts) => {
        refreshCalls.push(opts);
        await new Promise((r) => setTimeout(r, 15));
        tokenRefreshed = true;
        return { ok: true };
      },
      clearTokens: (keys) => {
        for (const k of keys) secrets.delete(k);
      },
    },
    http: {
      fetch: async (url, opts) => {
        fetchCount++;
        if (url.endsWith("/project") && !tokenRefreshed) {
          return { ok: false, status: 401, headers: {}, text: () => "unauthorized" };
        }
        if (url.endsWith("/project")) {
          return { ok: true, status: 200, headers: {}, text: () => "[]" };
        }
        if (url.includes("/task/missing-404")) {
          return { ok: false, status: 404, headers: {}, text: () => "Not Found" };
        }
        if (url.includes("/task/bad-json")) {
          return { ok: true, status: 200, headers: {}, text: () => "<html>not json</html>" };
        }
        if (url.includes("/task/rate-limit")) {
          return { ok: false, status: 429, headers: { "retry-after": "30" }, text: () => "slow down" };
        }
        if (url.includes("/project/inbox/data")) {
          return { ok: false, status: 500, headers: {}, text: () => "server boom" };
        }
        return { ok: true, status: 200, headers: {}, text: () => "{}" };
      },
    },
  };

  const api = createTickTickClient(mockFern, {
    getOAuthSetup: () => ({
      mode: "official",
      clientId: "official-cid",
      tokenUrl: "https://broker.example.com/token",
      clientSecretKey: undefined,
      tokenAuth: "body",
      ready: true,
    }),
    onAuthExpired: (msg) => expiredEvents.push(msg),
  });

  // 1. Concurrent 401s coalesce onto a SINGLE refresh using OFFICIAL_OAUTH setup
  const [p1, p2] = await Promise.all([api.listProjects(), api.listProjects()]);
  assert.deepEqual(p1, []);
  assert.deepEqual(p2, []);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].clientId, "official-cid");
  assert.equal(refreshCalls[0].tokenUrl, "https://broker.example.com/token");
  assert.equal(refreshCalls[0].tokenAuth, "body");

  // 2. Write 404 throws instead of faking success
  await assert.rejects(() => api.updateTask("missing-404", { title: "x" }), (err) => err.status === 404);
  await assert.rejects(() => api.completeTask("tp-1", "missing-404"), (err) => err.status === 404);
  await assert.rejects(() => api.deleteTask("tp-1", "missing-404"), (err) => err.status === 404);

  // 3. Invalid IDs rejected before hitting network
  const beforeNullCheck = fetchCount;
  await assert.rejects(() => api.getTask(null, "t1"), /Missing required TickTick projectId/);
  await assert.rejects(() => api.getTask("null", "t1"), /Missing required TickTick projectId/);
  assert.equal(fetchCount, beforeNullCheck);

  // 4. Invalid JSON throws structured INVALID_JSON error
  await assert.rejects(() => api.updateTask("bad-json", { title: "x" }), (err) => err.code === "INVALID_JSON");

  // 5. getInboxData propagates real 500 instead of swallowing it
  await assert.rejects(() => api.getInboxData(null), (err) => err.status === 500);

  // 6. 429 activates cooldown and blocks subsequent requests without hitting network
  await assert.rejects(() => api.updateTask("rate-limit", { title: "x" }), (err) => err.status === 429 && err.fatal);
  assert.ok(api.getRateLimitedUntil() > Date.now());
  const beforeCooldown = fetchCount;
  await assert.rejects(() => api.listProjects(), (err) => err.status === 429 && err.fatal);
  assert.equal(fetchCount, beforeCooldown);

  // 7. Unrecoverable 401 clears tokens and invokes onAuthExpired
  api.resetRateLimit();
  tokenRefreshed = false;
  mockFern.oauth.refresh = async () => {
    throw new Error("invalid_grant");
  };
  await assert.rejects(() => api.listProjects(), (err) => err.status === 401 && err.fatal);
  assert.equal(secrets.has("access_token"), false);
  assert.equal(secrets.has("refresh_token"), false);
  assert.equal(expiredEvents.length, 1);
});

test("H7: Cloudflare OAuth worker validates redirect_uri, Origin, body cap, env, grant_type, and pins scope", async () => {
  const env = { TICKTICK_CLIENT_ID: "cid-123", TICKTICK_CLIENT_SECRET: "sec-456" };
  const origFetch = globalThis.fetch;
  let capturedUpstream = null;

  globalThis.fetch = async (url, init) => {
    capturedUpstream = { url, init };
    return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
  };

  try {
    // 1. Method not allowed
    const rMethod = await worker.fetch(new Request("https://worker.test/token", { method: "GET" }), env);
    assert.equal(rMethod.status, 405);

    // 2. Rejects Origin header (CSRF)
    const rOrigin = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A18481%2Fcallback",
      }),
      env
    );
    assert.equal(rOrigin.status, 403);

    // 3. Rejects missing env secrets
    const rEnv = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=rt1",
      }),
      {}
    );
    assert.equal(rEnv.status, 500);

    // 4. Rejects redirect_uri prefix bypasses and wrong port/path/query
    for (const badUri of [
      "http://127.0.0.1:@attacker.com/callback",
      "http://127.0.0.1:18481.attacker.com/callback",
      "http://127.0.0.1:9999/callback",
      "http://127.0.0.1:18481/other",
      "http://127.0.0.1:18481/callback?extra=1",
      "https://127.0.0.1:18481/callback",
    ]) {
      const rBad = await worker.fetch(
        new Request("https://worker.test/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "abc",
            redirect_uri: badUri,
          }).toString(),
        }),
        env
      );
      assert.equal(rBad.status, 400, `Expected 400 for redirect_uri=${badUri}`);
    }

    // 5. Rejects oversized body (> 4096 bytes)
    const rBig = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=" + "a".repeat(5000),
      }),
      env
    );
    assert.equal(rBig.status, 413);

    // 6. Rejects invalid scope and mutually exclusive params
    const rBadScope = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt1",
          scope: "tasks:read admin:all",
        }).toString(),
      }),
      env
    );
    assert.equal(rBadScope.status, 400);

    const rMixed = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "abc",
          refresh_token: "rt1",
          redirect_uri: "http://127.0.0.1:18481/callback",
        }).toString(),
      }),
      env
    );
    assert.equal(rMixed.status, 400);

    // 7. Valid authorization_code succeeds, pins scope to "tasks:read tasks:write", forwards PKCE verifier
    const verifier = "a".repeat(48);
    const rOk = await worker.fetch(
      new Request("https://worker.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "good-code",
          redirect_uri: "http://127.0.0.1:18481/callback",
          code_verifier: verifier,
        }).toString(),
      }),
      env
    );
    assert.equal(rOk.status, 200);
    assert.equal(rOk.headers.get("cache-control"), "no-store");
    assert.ok(capturedUpstream);
    const forwarded = new URLSearchParams(capturedUpstream.init.body);
    assert.equal(forwarded.get("grant_type"), "authorization_code");
    assert.equal(forwarded.get("code"), "good-code");
    assert.equal(forwarded.get("redirect_uri"), "http://127.0.0.1:18481/callback");
    assert.equal(forwarded.get("scope"), "tasks:read tasks:write");
    assert.equal(forwarded.get("code_verifier"), verifier);
    assert.equal(capturedUpstream.init.headers.Authorization, `Basic ${btoa("cid-123:sec-456")}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("H36: ERULE and LUNAR repeat rules sync idempotently without RRULE wrapper; unsupported rules never crash fern.batch", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        { id: "tt-eb", title: "Forgetting curve", repeatFlag: "ERULE:NAME=FORGETTINGCURVE;CYCLE=2" },
        { id: "tt-lunar", title: "Lunar festival", repeatFlag: "LUNAR:FREQ=YEARLY;INTERVAL=1" },
        { id: "tt-bad", title: "Unsupported rule", repeatFlag: "ERULE:NAME=UNSUPPORTED_CUSTOM" },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  const r1 = await engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.pulled, 3);

  const tEb = Array.from(h.tasks.values()).find((t) => t.title === "Forgetting curve");
  const tLunar = Array.from(h.tasks.values()).find((t) => t.title === "Lunar festival");
  const tBad = Array.from(h.tasks.values()).find((t) => t.title === "Unsupported rule");
  assert.equal(tEb.repeat, "ERULE:NAME=FORGETTINGCURVE;CYCLE=2");
  assert.equal(tLunar.repeat, "LUNAR:FREQ=YEARLY;INTERVAL=1");
  assert.equal(tBad.repeat, null);

  // Sync #2 must be a pure no-op (no pull loop!)
  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.pulled, 0);
  assert.equal(r2.stats.pushed, 0);

  // Edit notes on ERULE & LUNAR tasks and verify pushed repeatFlag never wraps with "RRULE:"
  h.fern.tasks.update(tEb.id, { notes: "Study notes" });
  h.fern.tasks.update(tLunar.id, { notes: "Family dinner" });
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(r3.stats.pushed, 2);
  assert.equal(h.remoteTasks.get("tt-eb").repeatFlag, "ERULE:NAME=FORGETTINGCURVE;CYCLE=2");
  assert.equal(h.remoteTasks.get("tt-lunar").repeatFlag, "LUNAR:FREQ=YEARLY;INTERVAL=1");
});

test("C11 & M12 & M13: remote recurring completion without successor skips Phase D duplicate; 404 project fetch does not Trash; 429 aborts loop immediately", async () => {
  const h = createMockHarness({
    initialLists: [{ id: "fl-work", name: "Work" }],
    remoteProjects: [{ id: "tp-work", name: "Work" }],
    remoteTasksByProject: {
      "tp-work": [
        {
          id: "tt-recur-solo",
          title: "Solo recurring",
          dueDate: formatTickTickDate("2026-11-23", null),
          isAllDay: true,
          repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        },
        { id: "tt-keep-on-404", title: "Survives 404 project" },
      ],
    },
  });

  const engine = createSyncEngine(h.fern, h.api);
  await engine.syncNow();

  const localRecur = Array.from(h.tasks.values()).find((t) => t.title === "Solo recurring");
  const localKeep = Array.from(h.tasks.values()).find((t) => t.title === "Survives 404 project");

  // 1. Complete tt-recur-solo remotely with NO next occurrence returned yet
  const rec = h.remoteTasks.get("tt-recur-solo");
  h.remoteTasks.delete("tt-recur-solo");
  h.completedRemote.set("tt-recur-solo", { ...rec, status: 2, completedTime: new Date().toISOString() });

  const r2 = await engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(r2.stats.completed, 1);
  assert.equal(r2.stats.pushed, 0); // Phase D did NOT immediately push a duplicate!
  assert.equal(h.tasks.get(localRecur.id).completed, false);
  assert.equal(h.tasks.get(localRecur.id).dueDate, "2026-11-24");
  assert.equal(engine.loadState().tasks[localRecur.id], undefined);

  // 2. M12: getProjectData returns 404 -> must NOT add tp-work to fetchedProjectIds or Trash tt-keep-on-404!
  const origGetProjectData = h.api.getProjectData;
  h.api.getProjectData = async () => ({ notFound: true, project: null, tasks: [], columns: [] });
  h.apiCalls.length = 0;
  const r3 = await engine.syncNow();
  assert.equal(r3.ok, true);
  assert.equal(h.tasks.get(localKeep.id).deletedAt, null);
  assert.equal(h.apiCalls.filter((c) => c.op === "getTask").length, 0);

  // 3. M13: 429 fatal error in Phase D aborts immediately after 1 call (never hammers remaining tasks!)
  h.api.getProjectData = origGetProjectData;
  h.fern.tasks.create({ title: "Push 1", listId: "fl-work" });
  h.fern.tasks.create({ title: "Push 2", listId: "fl-work" });
  h.fern.tasks.create({ title: "Push 3", listId: "fl-work" });
  let createAttempts = 0;
  h.api.createTask = async () => {
    createAttempts++;
    const err = new Error("Rate limited");
    err.status = 429;
    err.fatal = true;
    throw err;
  };
  const r4 = await engine.syncNow();
  assert.equal(r4.ok, false);
  assert.equal(createAttempts, 1);
});
