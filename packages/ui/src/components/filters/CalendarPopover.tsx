import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";
import { cn } from "../../lib/utils";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export interface CalendarProps {
  value?: string; // selected ISO date
  onSelect: (iso?: string) => void;
}

// Month calendar date-picker for choosing a target date: month header with
// prev/next, a Su–Sa grid, today ringed, selected filled.
export function Calendar({ value, onSelect }: CalendarProps) {
  const today = new Date();
  const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());

  const initial = value ? new Date(`${value}T00:00:00`) : today;
  const [view, setView] = useState({
    year: initial.getFullYear(),
    month: initial.getMonth(),
  });

  const firstWeekday = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const daysInPrev = new Date(view.year, view.month, 0).getDate();

  // 6 rows × 7 cols, filled with leading/trailing days from adjacent months.
  const cells: { day: number; inMonth: boolean; y: number; m: number }[] = [];
  for (let i = 0; i < 42; i++) {
    const offset = i - firstWeekday;
    if (offset < 0) {
      cells.push({
        day: daysInPrev + offset + 1,
        inMonth: false,
        y: view.year,
        m: view.month - 1,
      });
    } else if (offset >= daysInMonth) {
      cells.push({
        day: offset - daysInMonth + 1,
        inMonth: false,
        y: view.year,
        m: view.month + 1,
      });
    } else {
      cells.push({
        day: offset + 1,
        inMonth: true,
        y: view.year,
        m: view.month,
      });
    }
  }

  function step(dir: -1 | 1) {
    setView((v) => {
      const m = v.month + dir;
      if (m < 0) return { year: v.year - 1, month: 11 };
      if (m > 11) return { year: v.year + 1, month: 0 };
      return { year: v.year, month: m };
    });
  }

  return (
    <div className="w-[236px] p-2">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => step(-1)}
          className="grid h-6 w-6 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeftIcon width={14} height={14} />
        </button>
        <span className="text-ui font-medium text-fg">
          {MONTH_NAMES[view.month]} {view.year}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => step(1)}
          className="grid h-6 w-6 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <ChevronRightIcon width={14} height={14} />
        </button>
      </div>

      <div className="grid grid-cols-7">
        {WEEKDAYS.map((w) => (
          <span
            key={w}
            className="grid h-7 place-items-center text-meta text-fg-tertiary"
          >
            {w}
          </span>
        ))}
        {cells.map((c, i) => {
          const cellIso = iso(c.y, c.m, c.day);
          const isToday = cellIso === todayIso;
          const isSelected = cellIso === value;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(cellIso)}
              className={cn(
                "grid h-7 place-items-center rounded-md text-sub tabular-nums transition-colors",
                !c.inMonth && "text-fg-tertiary/60",
                c.inMonth && !isSelected && "text-fg-muted hover:bg-surface-2",
                isToday &&
                  !isSelected &&
                  "ring-1 ring-inset ring-line-strong text-fg",
                isSelected && "bg-accent font-semibold text-white",
              )}
            >
              {c.day}
            </button>
          );
        })}
      </div>

      {value && (
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          className="mt-1.5 w-full rounded-md px-2 py-1 text-sub text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          Clear date
        </button>
      )}
    </div>
  );
}

export default Calendar;
