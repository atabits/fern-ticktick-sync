// Pure ES2022 date, priority, reminder, and canonical fingerprint helpers
// for TickTick Open API v1 <-> Fern synchronization.

function pad2(n) {
  return n < 10 ? "0" + String(n) : String(n);
}

/**
 * Parses a TickTick ISO timestamp such as "2026-11-22T21:00:00+0000" or
 * "2026-11-23T09:30:00.000+0300" into local date/time parts without UTC ±1 day drift.
 */
export function parseTickTickDate(raw, isAllDay = false) {
  if (!raw || typeof raw !== "string") return null;
  let normalized = raw.trim();
  if (!normalized) return null;
  // Convert "+0000" / "-0500" offset into ISO "+00:00" / "-05:00" for consistent Date parsing.
  normalized = normalized.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    // Fallback for plain YYYY-MM-DD strings.
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
    if (m) return { date: m[1], time: null, ms: Date.parse(m[1] + "T00:00:00Z") || 0 };
    return null;
  }
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = isAllDay ? null : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time, ms: d.getTime() };
}

/**
 * Formats a Fern local date ("YYYY-MM-DD") and optional time ("HH:MM")
 * into TickTick Open API v1 format: "yyyy-MM-dd'T'HH:mm:ss+HHMM".
 */
export function formatTickTickDate(dateStr, timeStr = null) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  let hour = 0;
  let minute = 0;
  if (timeStr && typeof timeStr === "string") {
    const tm = /^(\d{2}):(\d{2})/.exec(timeStr.trim());
    if (tm) {
      hour = Number(tm[1]);
      minute = Number(tm[2]);
    }
  }
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  // JS getTimezoneOffset() is minutes WEST of UTC (UTC+3 -> -180).
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad2(Math.floor(absMin / 60));
  const offM = pad2(absMin % 60);
  return `${dm[1]}-${dm[2]}-${dm[3]}T${pad2(hour)}:${pad2(minute)}:00${sign}${offH}${offM}`;
}

export function ttPriorityToFern(priority) {
  const n = Number(priority || 0);
  if (n >= 5) return "high";
  if (n >= 3) return "medium";
  if (n >= 1) return "low";
  return "none";
}

export function fernPriorityToTt(priority) {
  if (priority === "high" || priority === 5) return 5;
  if (priority === "medium" || priority === 3) return 3;
  if (priority === "low" || priority === 1) return 1;
  return 0;
}

/**
 * Exact JS counterpart to fern_core::import::reminder_minutes.
 */
export function ttReminderToMinutes(trigger, allDay) {
  if (!trigger || typeof trigger !== "string") return null;
  let value = trigger.trim();
  if (value.startsWith("TRIGGER:")) value = value.slice(8);
  let sign = 1;
  if (value.startsWith("-")) {
    sign = -1;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  if (!value.startsWith("P")) return null;
  const rest = value.slice(1);
  const tIdx = rest.indexOf("T");
  const daysPart = tIdx >= 0 ? rest.slice(0, tIdx) : rest;
  const timePart = tIdx >= 0 ? rest.slice(tIdx + 1) : "";

  let minutes = 0;
  if (daysPart) {
    if (daysPart.endsWith("D")) {
      const n = Number(daysPart.slice(0, -1));
      if (!Number.isFinite(n)) return null;
      minutes += n * 24 * 60;
    } else if (daysPart.endsWith("W")) {
      const n = Number(daysPart.slice(0, -1));
      if (!Number.isFinite(n)) return null;
      minutes += n * 7 * 24 * 60;
    } else {
      return null;
    }
  }

  let numBuf = "";
  for (let i = 0; i < timePart.length; i++) {
    const ch = timePart[i];
    if (ch >= "0" && ch <= "9") {
      numBuf += ch;
      continue;
    }
    const n = Number(numBuf);
    numBuf = "";
    if (!Number.isFinite(n)) return null;
    if (ch === "H") minutes += n * 60;
    else if (ch === "M") minutes += n;
    else if (ch === "S") {
      // seconds ignored in minute granularity
    } else {
      return null;
    }
  }

  const offset = sign * minutes;
  const result = allDay ? 9 * 60 - offset : -offset;
  return result === 0 ? 0 : result;
}

export function minutesToTtReminder(minutes, allDay) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m)) return null;
  const offset = allDay ? 9 * 60 - m : -m;
  if (offset === 0) return "TRIGGER:PT0S";
  const sign = offset < 0 ? "-" : "";
  const abs = Math.abs(offset);
  const days = Math.floor(abs / 1440);
  const rem = abs % 1440;
  const hours = Math.floor(rem / 60);
  const mins = rem % 60;
  let out = `TRIGGER:${sign}P`;
  if (days > 0) out += `${days}D`;
  if (hours > 0 || mins > 0 || days === 0) {
    out += "T";
    if (hours > 0) out += `${hours}H`;
    if (mins > 0 || (days === 0 && hours === 0)) out += `${mins}M`;
    out += "0S";
  }
  return out;
}

export function normalizeRepeat(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("RRULE:") ? trimmed : `RRULE:${trimmed}`;
}

export function normalizeTitle(title) {
  return String(title || "").trim().replace(/\s+/g, " ");
}

export function normalizeChecklist(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      const title = String(it.title || "").trim();
      if (!title) return null;
      const completed = Boolean(
        it.completed === true || it.status === 1 || it.status === 2
      );
      return { title, completed };
    })
    .filter(Boolean);
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const t = String(raw || "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}

/**
 * Extracts a canonical, comparable representation from a TickTick Open API v1 task.
 */
export function normalizeTickTickTask(ttTask, fernListId = null, fernParentId = null) {
  const isAllDay = ttTask.isAllDay !== false;
  const due = parseTickTickDate(ttTask.dueDate, isAllDay);
  const start = parseTickTickDate(ttTask.startDate, isAllDay);

  // TickTick often sets startDate == dueDate for single-day due tasks; mirror Fern's dueDate/endDate model.
  let dueDate = null;
  let dueTime = null;
  let endDate = null;
  let endTime = null;

  if (due && start && (start.date !== due.date || start.time !== due.time)) {
    dueDate = start.date;
    dueTime = start.time;
    endDate = due.date;
    endTime = due.time;
  } else if (due) {
    dueDate = due.date;
    dueTime = due.time;
  } else if (start) {
    dueDate = start.date;
    dueTime = start.time;
  }

  const allDayFlag = dueTime == null;
  const reminders = Array.isArray(ttTask.reminders)
    ? ttTask.reminders
        .map((r) => ttReminderToMinutes(r, allDayFlag))
        .filter((v) => v !== null)
        .sort((a, b) => a - b)
    : [];

  const notes =
    typeof ttTask.content === "string" && ttTask.content.length > 0
      ? ttTask.content
      : typeof ttTask.desc === "string"
        ? ttTask.desc
        : "";

  return {
    title: normalizeTitle(ttTask.title),
    notes: notes.trim(),
    listId: fernListId || null,
    parentId: fernParentId || null,
    priority: ttPriorityToFern(ttTask.priority),
    dueDate,
    dueTime,
    endDate,
    endTime,
    repeat: normalizeRepeat(ttTask.repeatFlag || ttTask.repeat),
    tags: normalizeTags(ttTask.tags),
    checklist: normalizeChecklist(ttTask.items),
    reminders,
    completed: Number(ttTask.status || 0) >= 1,
  };
}

/**
 * Extracts the exact same canonical representation from a Fern task + checklist array.
 */
export function normalizeFernTask(fernTask, checklistItems = []) {
  const reminders = Array.isArray(fernTask.reminders)
    ? fernTask.reminders
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
    : [];

  return {
    title: normalizeTitle(fernTask.title),
    notes: String(fernTask.notes || "").trim(),
    listId: fernTask.listId || null,
    parentId: fernTask.parentId || null,
    priority: ttPriorityToFern(fernPriorityToTt(fernTask.priority)),
    dueDate: fernTask.dueDate || null,
    dueTime: fernTask.dueTime || null,
    endDate: fernTask.endDate || null,
    endTime: fernTask.endTime || null,
    repeat: normalizeRepeat(fernTask.repeat),
    tags: normalizeTags(fernTask.tags),
    checklist: normalizeChecklist(checklistItems),
    reminders,
    completed: Boolean(fernTask.completed),
  };
}

/**
 * Deterministic 64-bit hex FNV-1a fingerprint over canonical synced task fields.
 */
export function canonicalTaskHash(norm) {
  const payload = JSON.stringify({
    title: norm.title,
    notes: norm.notes,
    listId: norm.listId,
    parentId: norm.parentId,
    priority: norm.priority,
    dueDate: norm.dueDate,
    dueTime: norm.dueTime,
    endDate: norm.endDate,
    endTime: norm.endTime,
    repeat: norm.repeat,
    tags: norm.tags,
    checklist: norm.checklist,
    reminders: norm.reminders,
    completed: norm.completed,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Converts a normalized TickTick task into a Fern TaskDraft / TaskPatch object.
 */
export function normalizedToFernPatch(norm) {
  return {
    title: norm.title || "Untitled",
    notes: norm.notes,
    listId: norm.listId,
    parentId: norm.parentId,
    priority: norm.priority,
    dueDate: norm.dueDate,
    dueTime: norm.dueTime,
    endDate: norm.endDate,
    endTime: norm.endTime,
    repeat: norm.repeat,
    tags: norm.tags,
    checklist: norm.checklist,
    reminders: norm.reminders,
  };
}

/**
 * Converts a Fern task + checklist into a TickTick Open API v1 create/update payload.
 */
export function fernTaskToTtPayload(fernTask, checklistItems, ttProjectId, existingTtId = null, ttParentId = null) {
  const norm = normalizeFernTask(fernTask, checklistItems);
  const allDay = norm.dueTime == null && norm.endTime == null;
  const payload = {
    title: norm.title || "Untitled",
    content: norm.notes || "",
    priority: fernPriorityToTt(norm.priority),
    isAllDay: allDay,
  };
  if (existingTtId) {
    payload.id = existingTtId;
  }
  if (ttProjectId) {
    payload.projectId = ttProjectId;
  }
  if (ttParentId) {
    payload.parentId = ttParentId;
  }
  if (norm.dueDate) {
    if (norm.endDate) {
      payload.startDate = formatTickTickDate(norm.dueDate, norm.dueTime);
      payload.dueDate = formatTickTickDate(norm.endDate, norm.endTime || norm.dueTime);
    } else {
      payload.dueDate = formatTickTickDate(norm.dueDate, norm.dueTime);
      payload.startDate = payload.dueDate;
    }
  }
  if (norm.repeat) {
    payload.repeatFlag = norm.repeat;
  }
  if (norm.tags.length > 0) {
    payload.tags = norm.tags;
  }
  if (norm.reminders.length > 0) {
    payload.reminders = norm.reminders
      .map((m) => minutesToTtReminder(m, allDay))
      .filter(Boolean);
  }
  if (norm.checklist.length > 0) {
    payload.items = norm.checklist.map((item, idx) => ({
      title: item.title,
      status: item.completed ? 1 : 0,
      sortOrder: idx * 1000,
    }));
  }
  return payload;
}

export function dedupKey(title, dueDate) {
  return `${normalizeTitle(title).toLowerCase()}||${dueDate || ""}`;
}

export function parseModifiedMs(ttTask) {
  const raw = ttTask.modifiedTime || ttTask.completedTime || ttTask.createdTime;
  const parsed = parseTickTickDate(raw, false);
  return parsed ? parsed.ms : 0;
}
