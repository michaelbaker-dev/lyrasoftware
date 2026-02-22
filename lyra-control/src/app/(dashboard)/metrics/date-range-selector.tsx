"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

const RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "sprint", label: "Current Sprint" },
];

export default function DateRangeSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const current = searchParams.get("range") || "7d";

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "7d") {
      params.set("range", value);
    } else {
      params.delete("range");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <select
      value={current}
      onChange={handleChange}
      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm"
    >
      {RANGES.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
