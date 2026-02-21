"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

interface Project {
  id: string;
  name: string;
}

export default function ProjectSelector({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const currentProjectId = searchParams.get("project") || "";

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("project", value);
    } else {
      params.delete("project");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <select
      value={currentProjectId}
      onChange={handleChange}
      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm"
    >
      <option value="">All Projects</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
