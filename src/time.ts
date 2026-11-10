// Every date the agent reasons about is a calendar date in the user's time zone
// ("YYYY-MM-DD"). "Monday" means the user's Monday, not the server's.

export interface LocalTime {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function safeTimeZone(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return value;
    } catch {
      // fall through to the server's zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function toLocal(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  return {
    date: ymd(year, month, day),
    year,
    month,
    day,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: part("weekday"),
  };
}

export function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function asUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

export function addDays(date: string, days: number): string {
  const t = asUtc(date);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function weekdayIndex(date: string): number {
  return asUtc(date).getUTCDay();
}

export function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function describeDate(date: string): string {
  const t = asUtc(date);
  return `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

export function describeRange(from: string, to: string): string {
  return from === to ? describeDate(from) : `${describeDate(from)} to ${describeDate(to)}`;
}

export function describeNow(instant: Date, timeZone: string): string {
  const local = toLocal(instant, timeZone);
  const hh = String(local.hour).padStart(2, "0");
  const mm = String(local.minute).padStart(2, "0");
  return `${local.weekday} ${describeDate(local.date).slice(4)}, ${hh}:${mm} (${timeZone})`;
}

export function describeInstant(iso: string, timeZone: string): string {
  const local = toLocal(new Date(iso), timeZone);
  const hh = String(local.hour).padStart(2, "0");
  const mm = String(local.minute).padStart(2, "0");
  return `${describeDate(local.date)}, ${hh}:${mm}`;
}
