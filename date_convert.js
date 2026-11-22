// Pure ES2022 date, priority, reminder, repeat, and canonical fingerprint helpers
// for TickTick Open API v1 <-> Fern synchronization.

const BYDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WORKDAYS_MASK = 0b0001_1111; // MO..FR

function pad2(n) {
  return n < 10 ? "0" + String(n) : String(n);
}

function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * Shifts a calendar date ("YYYY-MM-DD") by `deltaDays` using DST-free UTC math.
 */
export function shiftIsoDate(dateStr, deltaDays) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  if (!isValidYmd(year, month, day)) return null;
  const dt = new Date(Date.UTC(year, month - 1, day + deltaDays));
  if (Number.isNaN(dt.getTime())) return null;
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * Parses a TickTick ISO timestamp such as "2026-11-22T21:00:00+0000",
 * "2026-11-23T09:30:00.000+0300", or plain "2026-11-23" into local date/time
 * parts without UTC ±1 day drift in UTC- timezones.
 */
export function parseTickTickDate(raw, isAllDay = false) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Plain YYYY-MM-DD: always treat as a local calendar date (never UTC midnight).
  const plainMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (plainMatch) {
    const y = Number(plainMatch[1]);
    const m = Number(plainMatch[2]);
    const day = Number(plainMatch[3]);
    if (!isValidYmd(y, m, day)) return null;
    const localMid = new Date(y, m - 1, day, 0, 0, 0, 0);
    return {
      date: `${plainMatch[1]}-${plainMatch[2]}-${plainMatch[3]}`,
      time: null,
      ms: localMid.getTime(),
    };
  }

  // Convert "+0000" / "-0500" offset into ISO "+00:00" / "-05:00" for consistent Date parsing.
  const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");

  // 2. All-day timestamp already at exact midnight (00:00:00) in its declared offset / UTC:
  // preserve its calendar date verbatim so UTC- timezones never shift -1 day.
  if (isAllDay) {
    const midnightMatch = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(normalized);
    if (midnightMatch) {
      const y = Number(midnightMatch[1]);
      const m = Number(midnightMatch[2]);
      const day = Number(midnightMatch[3]);
      if (!isValidYmd(y, m, day)) return null;
      const parsedMs = Date.parse(normalized);
      const localMid = new Date(y, m - 1, day, 0, 0, 0, 0);
      return {
        date: `${midnightMatch[1]}-${midnightMatch[2]}-${midnightMatch[3]}`,
        time: null,
        ms: Number.isNaN(parsedMs) ? localMid.getTime() : parsedMs,
      };
    }
  }

  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const date = `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = isAllDay ? null : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time, ms: d.getTime() };
}

/**
 * Formats a Fern local date ("YYYY-MM-DD") and optional time ("HH:MM")
 * into TickTick Open API v1 format: "yyyy-MM-dd'T'HH:mm:ss+HHMM".
 * Computes the DST offset at the target date and formats `d`'s actual local
 * components so DST spring-forward gaps never mix rolled offsets with unrolled hours.
 */
export function formatTickTickDate(dateStr, timeStr = null) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  if (!isValidYmd(year, month, day)) return null;

  let hour = 0;
  let minute = 0;
  if (timeStr && typeof timeStr === "string") {
    const tm = /^(\d{2}):(\d{2})/.exec(timeStr.trim());
    if (tm) {
      hour = Number(tm[1]);
      minute = Number(tm[2]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
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
  const outYear = String(d.getFullYear()).padStart(4, "0");
  const outMonth = pad2(d.getMonth() + 1);
  const outDay = pad2(d.getDate());
  const outHour = pad2(d.getHours());
  const outMin = pad2(d.getMinutes());
  return `${outYear}-${outMonth}-${outDay}T${outHour}:${outMin}:00${sign}${offH}${offM}`;
}

function inferTickTickAllDay(ttTask) {
  if (ttTask.isAllDay === true) return true;
  if (ttTask.isAllDay === false) return false;
  const raws = [ttTask.dueDate, ttTask.startDate].filter(
    (v) => typeof v === "string" && v.trim().length > 0
  );
  if (raws.length === 0) return true;
  for (const raw of raws) {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue;
    const parsed = parseTickTickDate(trimmed, false);
    if (parsed && parsed.time && parsed.time !== "00:00") {
      return false;
    }
  }
  return true;
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
 * Supports TRIGGER: and TRIGGER;RELATED=START: / TRIGGER;VALUE=DURATION: parameters
 * and rejects malformed durations such as "TRIGGER:PTH" or "TRIGGER:-PT15".
 */
export function ttReminderToMinutes(trigger, allDay) {
  if (!trigger || typeof trigger !== "string") return null;
  let value = trigger.trim();
  if (/^TRIGGER(?:;[^:]*)?:/i.test(value)) {
    value = value.slice(value.indexOf(":") + 1).trim();
  }
  let sign = 1;
  if (value.startsWith("-")) {
    sign = -1;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  if (!value.startsWith("P")) return null;
  const rest = value.slice(1);
  if (!rest) return null;

  const tIdx = rest.indexOf("T");
  const daysPart = tIdx >= 0 ? rest.slice(0, tIdx) : rest;
  const timePart = tIdx >= 0 ? rest.slice(tIdx + 1) : "";
  if (tIdx >= 0 && !timePart) return null;

  let minutes = 0;
  let hasUnit = false;

  if (daysPart) {
    const dm = /^(\d+)([DW])$/.exec(daysPart);
    if (!dm) return null;
    const n = Number(dm[1]);
    if (!Number.isFinite(n)) return null;
    minutes += dm[2] === "W" ? n * 7 * 24 * 60 : n * 24 * 60;
    hasUnit = true;
  }

  let numBuf = "";
  for (let i = 0; i < timePart.length; i++) {
    const ch = timePart[i];
    if (ch >= "0" && ch <= "9") {
      numBuf += ch;
      continue;
    }
    if (!numBuf) return null;
    const n = Number(numBuf);
    numBuf = "";
    if (!Number.isFinite(n)) return null;
    if (ch === "H") {
      minutes += n * 60;
      hasUnit = true;
    } else if (ch === "M") {
      minutes += n;
      hasUnit = true;
    } else if (ch === "S") {
      // seconds ignored in minute granularity
      hasUnit = true;
    } else {
      return null;
    }
  }
  if (numBuf.length > 0 || !hasUnit) return null;

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

function formatSkipSuffix(skipWeekends, skipHolidays) {
  if (skipWeekends && skipHolidays) return ";TT_SKIP=HOLIDAY,WEEKEND";
  if (skipHolidays) return ";TT_SKIP=HOLIDAY";
  if (skipWeekends) return ";X-SKIP=WEEKEND";
  return "";
}

function parseSkipTokens(value, state) {
  for (const token of value.split(",").map((s) => s.trim())) {
    if (token === "WEEKEND") state.skipWeekends = true;
    else if (token === "HOLIDAY") state.skipHolidays = true;
  }
}

function parseCompactYmd(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return null;
  if (!isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  return raw;
}

/**
 * Canonicalizes a TickTick or Fern repeat rule into Fern's exact canonical
 * `Recurrence::to_string()` representation, preserving `ERULE:` and `LUNAR:`
 * prefixes and returning `null` for rules unsupported by Fern (preventing
 * `fern.tasks.create` crashes inside `fern.batch` and preventing INTERVAL=1 loops).
 */
export function normalizeRepeat(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("ERULE:")) {
    const body = trimmed.slice(6);
    let name = null;
    let cycle = 0;
    const dates = [];
    const flags = { skipWeekends: false, skipHolidays: false, fromCompletion: false };
    for (const part of body.split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq < 0) return null;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (key === "NAME") {
        name = value;
      } else if (key === "CYCLE") {
        if (!/^\d+$/.test(value)) return null;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n > 0xffffffff) return null;
        cycle = n;
      } else if (key === "BYDATE") {
        for (const d of value.split(",")) {
          if (!d) continue;
          const valid = parseCompactYmd(d);
          if (!valid) return null;
          dates.push(valid);
        }
      } else if (key === "X-SKIP" || key === "TT_SKIP") {
        parseSkipTokens(value, flags);
      } else if (key === "X-FROM") {
        flags.fromCompletion = value === "COMPLETION";
      }
    }
    const skipStr = formatSkipSuffix(flags.skipWeekends, flags.skipHolidays);
    const fromStr = flags.fromCompletion ? ";X-FROM=COMPLETION" : "";
    if (name === "FORGETTINGCURVE") {
      return `ERULE:NAME=FORGETTINGCURVE;CYCLE=${cycle}${skipStr}${fromStr}`;
    }
    if (name === "CUSTOM" && dates.length > 0) {
      const uniq = Array.from(new Set(dates)).sort();
      return `FREQ=DAILY;INTERVAL=1${skipStr}${fromStr};X-DATES=${uniq.join(",")}`;
    }
    return null;
  }

  let lunar = false;
  let rule = trimmed;
  if (trimmed.startsWith("LUNAR:")) {
    lunar = true;
    rule = trimmed.slice(6);
  } else if (trimmed.startsWith("RRULE:")) {
    rule = trimmed.slice(6);
    // Reject double-prefixed invalid rules like "RRULE:ERULE:..." or "RRULE:LUNAR:..."
    if (rule.startsWith("ERULE:") || rule.startsWith("LUNAR:")) {
      return normalizeRepeat(rule);
    }
  }

  let frequency = null;
  let interval = 1;
  let weekdays = 0;
  let monthDays = 0;
  let hasLastDay = false;
  let nthWeekday = null;
  let setpos = null;
  const flags = { skipWeekends: false, skipHolidays: false, fromCompletion: false };
  const dates = [];

  for (const part of rule.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "FREQ") {
      if (value !== "DAILY" && value !== "WEEKLY" && value !== "MONTHLY" && value !== "YEARLY") {
        return null;
      }
      frequency = value;
    } else if (key === "INTERVAL") {
      if (!/^\d+$/.test(value)) return null;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n > 0xffffffff) return null;
      interval = Math.max(1, n);
    } else if (key === "BYDAY") {
      for (const code of value.split(",")) {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(code);
        if (!m) return null;
        const dayIdx = BYDAY_CODES.indexOf(m[2]);
        if (dayIdx < 0) return null;
        if (!m[1]) {
          weekdays |= 1 << dayIdx;
        } else {
          const nth = Number(m[1]);
          if (!Number.isInteger(nth) || nth === 0 || nth < -128 || nth > 127) return null;
          nthWeekday = [nth, dayIdx];
        }
      }
    } else if (key === "BYMONTHDAY") {
      for (const rawDay of value.split(",")) {
        if (!/^-?\d+$/.test(rawDay)) return null;
        const d = Number(rawDay);
        if (d === -1) {
          hasLastDay = true;
        } else if (d >= 1 && d <= 31) {
          monthDays |= 1 << (d - 1);
        } else {
          return null;
        }
      }
    } else if (key === "BYSETPOS") {
      if (!/^[+-]?\d+$/.test(value)) return null;
      const pos = Number(value);
      if (!Number.isInteger(pos) || pos === 0 || pos < -128 || pos > 127) return null;
      setpos = pos;
    } else if (key === "X-SKIP" || key === "TT_SKIP") {
      parseSkipTokens(value, flags);
    } else if (key === "X-FROM") {
      flags.fromCompletion = value === "COMPLETION";
    } else if (key === "X-DATES") {
      for (const d of value.split(",")) {
        if (!d) continue;
        const valid = parseCompactYmd(d);
        if (!valid) return null;
        dates.push(valid);
      }
    }
    // Other RRULE parts (WKST, COUNT, UNTIL, etc.) are ignored, matching fern_core::Recurrence.
  }

  if (!frequency) return null;

  let out = `${lunar ? "LUNAR:" : ""}FREQ=${frequency};INTERVAL=${interval}`;
  if (frequency === "WEEKLY" && weekdays !== 0) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      if (weekdays & (1 << i)) days.push(BYDAY_CODES[i]);
    }
    out += `;BYDAY=${days.join(",")}`;
  }
  if (frequency === "MONTHLY") {
    if (setpos !== null && weekdays === WORKDAYS_MASK) {
      out += `;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${setpos}`;
    } else {
      if (monthDays !== 0 || hasLastDay) {
        const days = [];
        for (let i = 0; i < 31; i++) {
          if (monthDays & (1 << i)) days.push(String(i + 1));
        }
        if (hasLastDay) days.push("-1");
        out += `;BYMONTHDAY=${days.join(",")}`;
      }
      if (nthWeekday) {
        out += `;BYDAY=${nthWeekday[0]}${BYDAY_CODES[nthWeekday[1]]}`;
      }
    }
  }
  out += formatSkipSuffix(flags.skipWeekends, flags.skipHolidays);
  if (flags.fromCompletion) {
    out += ";X-FROM=COMPLETION";
  }
  if (dates.length > 0) {
    const uniq = Array.from(new Set(dates)).sort();
    out += `;X-DATES=${uniq.join(",")}`;
  }
  return out;
}

/**
 * Formats a normalized Fern repeat string for TickTick's `repeatFlag` field.
 * Preserves `ERULE:` and `LUNAR:` prefixes verbatim and prefixes standard rules with `RRULE:`.
 */
export function formatRepeatForTickTick(normRepeat) {
  if (!normRepeat || typeof normRepeat !== "string") return "";
  const trimmed = normRepeat.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("ERULE:") || trimmed.startsWith("LUNAR:") || trimmed.startsWith("RRULE:")) {
    return trimmed;
  }
  return `RRULE:${trimmed}`;
}

export function normalizeTitle(title) {
  return String(title || "").trim().replace(/\s+/g, " ");
}

export function normalizeChecklist(items) {
  if (!Array.isArray(items)) return [];
  const decorated = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (!it || typeof it !== "object") continue;
    const title = String(it.title || "").trim();
    if (!title) continue;
    const completed = Boolean(
      it.completed === true || it.status === 1 || it.status === 2
    );
    const order =
      typeof it.sortOrder === "number" && Number.isFinite(it.sortOrder)
        ? it.sortOrder
        : null;
    decorated.push({ title, completed, order, idx });
  }
  if (decorated.some((d) => d.order !== null)) {
    decorated.sort((a, b) => {
      if (a.order !== null && b.order !== null && a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.order !== null && b.order === null) return -1;
      if (a.order === null && b.order !== null) return 1;
      return a.idx - b.idx;
    });
  }
  return decorated.map(({ title, completed }) => ({ title, completed }));
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

function dedupSortedNumbers(nums) {
  const uniq = Array.from(new Set(nums));
  uniq.sort((a, b) => a - b);
  return uniq;
}

/**
 * Extracts a canonical, comparable representation from a TickTick Open API v1 task.
 */
export function normalizeTickTickTask(ttTask, fernListId = null, fernParentId = null) {
  const isAllDay = inferTickTickAllDay(ttTask);
  const due = parseTickTickDate(ttTask.dueDate, isAllDay);
  const start = parseTickTickDate(ttTask.startDate, isAllDay);

  // Mirror Fern's dueDate/endDate model and TickTick's exclusive-midnight convention
  // for multi-day all-day spans (matching fern_core::import).
  let dueDate = null;
  let dueTime = null;
  let endDate = null;
  let endTime = null;

  if (due && start) {
    dueDate = start.date;
    dueTime = start.time;
    if (isAllDay) {
      const inclusiveEnd = shiftIsoDate(due.date, -1);
      if (inclusiveEnd && inclusiveEnd > start.date) {
        endDate = inclusiveEnd;
        endTime = null;
      }
    } else if (due.ms > start.ms) {
      endDate = due.date;
      endTime = due.time;
    }
  } else if (due) {
    dueDate = due.date;
    dueTime = due.time;
  } else if (start) {
    dueDate = start.date;
    dueTime = start.time;
  }

  const allDayFlag = dueTime == null;
  const reminders = Array.isArray(ttTask.reminders)
    ? dedupSortedNumbers(
        ttTask.reminders
          .map((r) => ttReminderToMinutes(r, allDayFlag))
          .filter((v) => v !== null)
      )
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
    completed: Number(ttTask.status || 0) !== 0,
  };
}

/**
 * Extracts the exact same canonical representation from a Fern task + checklist array.
 */
export function normalizeFernTask(fernTask, checklistItems = []) {
  const reminders = Array.isArray(fernTask.reminders)
    ? dedupSortedNumbers(
        fernTask.reminders
          .map((n) => Math.round(Number(n)))
          .filter((n) => Number.isFinite(n))
      )
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
    completed: Boolean(fernTask.completed || fernTask.wontDoAt),
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
 * When `existingTtId` is provided (update), cleared fields are sent explicitly as
 * null/empty so TickTick actually clears them instead of keeping stale values.
 */
export function fernTaskToTtPayload(fernTask, checklistItems, ttProjectId, existingTtId = null, ttParentId = null) {
  const norm = normalizeFernTask(fernTask, checklistItems);
  const isUpdate = Boolean(existingTtId);
  const allDay = norm.dueTime == null && norm.endTime == null;
  const payload = {
    title: norm.title || "Untitled",
    content: norm.notes || "",
    priority: fernPriorityToTt(norm.priority),
    isAllDay: allDay,
  };
  if (isUpdate) {
    payload.id = existingTtId;
    payload.desc = norm.checklist.length > 0 ? norm.notes || "" : "";
  } else if (norm.checklist.length > 0 && norm.notes) {
    payload.desc = norm.notes;
  }
  if (ttProjectId) {
    payload.projectId = ttProjectId;
  }
  if (ttParentId) {
    payload.parentId = ttParentId;
  } else if (isUpdate) {
    payload.parentId = null;
  }
  if (norm.dueDate) {
    if (norm.endDate) {
      payload.startDate = formatTickTickDate(norm.dueDate, norm.dueTime);
      if (allDay) {
        const exclusiveEnd = shiftIsoDate(norm.endDate, 1) || norm.endDate;
        payload.dueDate = formatTickTickDate(exclusiveEnd, null);
      } else {
        payload.dueDate = formatTickTickDate(norm.endDate, norm.endTime || norm.dueTime);
      }
    } else {
      payload.dueDate = formatTickTickDate(norm.dueDate, norm.dueTime);
      payload.startDate = payload.dueDate;
    }
  } else if (isUpdate) {
    payload.dueDate = null;
    payload.startDate = null;
  }
  if (norm.repeat) {
    payload.repeatFlag = formatRepeatForTickTick(norm.repeat);
  } else if (isUpdate) {
    payload.repeatFlag = "";
  }
  if (norm.tags.length > 0) {
    payload.tags = norm.tags;
  } else if (isUpdate) {
    payload.tags = [];
  }
  if (norm.reminders.length > 0) {
    payload.reminders = norm.reminders
      .map((m) => minutesToTtReminder(m, allDay))
      .filter(Boolean);
  } else if (isUpdate) {
    payload.reminders = [];
  }
  if (norm.checklist.length > 0) {
    payload.items = norm.checklist.map((item, idx) => ({
      title: item.title,
      status: item.completed ? 1 : 0,
      sortOrder: idx * 1000,
    }));
  } else if (isUpdate) {
    payload.items = [];
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
