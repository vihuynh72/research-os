"use client";

// Segmented control: a group of toggle buttons where exactly one is pressed. Used for the
// 2D | 3D view switch and for the Parent | Researcher persona switch.
import type { View } from "./format";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  label: string; // accessible name of the group
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
}

export function Segmented<T extends string>({ label, options, value, onChange, className = "" }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={`inline-flex shrink-0 rounded-full bg-surface-2 p-0.5 ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="min-h-7 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/0.12)] pointer-coarse:min-h-9"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const VIEWS: SegmentOption<View>[] = [
  { value: "2d", label: "2D" },
  { value: "3d", label: "3D" },
];

export default function ViewToggle({ view, onChange, className }: { view: View; onChange(view: View): void; className?: string }) {
  return <Segmented label="Map view" options={VIEWS} value={view} onChange={onChange} className={className} />;
}
