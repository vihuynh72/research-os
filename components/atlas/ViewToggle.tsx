"use client";

// Segmented control: a group of toggle buttons where exactly one is pressed. Used for the
// Map | 3D | List switch and for the Caregiver | Researcher persona switch.

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  label: string; // accessible name of the group
  title?: string; // what the choice does, shown on hover
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
}

export function Segmented<T extends string>({ label, title, options, value, onChange, className = "" }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} title={title} className={`inline-flex shrink-0 rounded-full bg-surface-2 p-0.5 ring-1 ring-line ring-inset ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="min-h-8 rounded-full px-2.5 text-[0.8125rem] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_0.5px_rgb(0_0_0/0.06)] pointer-coarse:min-h-9 sm:px-3.5"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// How the neighborhood is shown: the map, the same map in 3D, or the list that reads it out.
export type Display = "map" | "3d" | "list";

const DISPLAYS: SegmentOption<Display>[] = [
  { value: "map", label: "Map" },
  { value: "3d", label: "3D" },
  { value: "list", label: "List" },
];

export default function ViewToggle({ value, onChange, className }: { value: Display; onChange(value: Display): void; className?: string }) {
  return <Segmented label="Show as" options={DISPLAYS} value={value} onChange={onChange} className={className} />;
}
