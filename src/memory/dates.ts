import * as chrono from "chrono-node";
import { addDays, describeRange, lastDayOfMonth, weekdayIndex, ymd, type LocalTime } from "../time.ts";

export interface DateWindow {
  from: string;
  to: string;
  phrase: string;
  label: string;
}

const NOT_THE_PAST = /\b(today|tonight|now|tomorrow|next|upcoming|coming)\b/i;

// Turns the past-tense date phrases in a message into inclusive windows of local
// calendar dates. Ambiguous phrases lean backwards: "on Monday we shortlisted"
// said on a Tuesday means yesterday, and a bare "Friday" means the last one.
export function resolvePastDates(text: string, today: LocalTime): DateWindow[] {
  const reference = new Date(today.year, today.month - 1, today.day, 12);
  const windows: DateWindow[] = [];

  for (const result of chrono.parse(text, reference, { forwardDate: false })) {
    const phrase = result.text.trim();
    if (NOT_THE_PAST.test(phrase)) continue;

    const start = result.start;
    const year = start.get("year") ?? today.year;
    const month = start.get("month") ?? today.month;
    const day = start.get("day") ?? 1;
    let date = ymd(year, month, day);
    let from: string;
    let to: string;

    if (start.isCertain("day")) {
      if (date > today.date) date = ymd(year - 1, month, day);
      if (/\bweeks?\b/i.test(phrase)) {
        from = addDays(date, -((weekdayIndex(date) + 6) % 7));
        to = addDays(from, 6);
      } else if (/\bdays\b/i.test(phrase)) {
        from = addDays(date, -1);
        to = addDays(date, 1);
      } else {
        from = date;
        to = date;
      }
    } else if (start.isCertain("weekday")) {
      if (date >= today.date) date = addDays(date, -7);
      from = date;
      to = date;
    } else if (start.isCertain("month")) {
      let y = year;
      if (ymd(y, month, 1) > today.date) y -= 1;
      from = ymd(y, month, 1);
      to = lastDayOfMonth(y, month);
    } else {
      continue;
    }

    if (to > today.date) to = today.date;
    if (from > to) continue;
    if (windows.some((w) => w.from === from && w.to === to)) continue;
    windows.push({ from, to, phrase, label: describeRange(from, to) });
  }

  return windows;
}
