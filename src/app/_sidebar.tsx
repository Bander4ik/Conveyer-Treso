"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const LINKS = [
  { href: "/", label: "New Video", icon: "✦" },
  { href: "/runs", label: "Runs", icon: "▤" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside
      className="w-60 shrink-0 border-r px-4 py-6 flex flex-col gap-1"
      style={{ borderColor: "var(--border)", background: "var(--bg-soft)" }}
    >
      <div className="px-3 mb-6">
        <div className="text-lg font-bold" style={{ color: "var(--accent-strong)" }}>
          Conveyer Treso
        </div>
        <div className="text-xs mt-0.5" style={{ color: "var(--text-dim)" }}>
          mystic stills → video
        </div>
      </div>
      {LINKS.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={clsx("sidebar-link", active && "active")}>
            <span className="w-4 text-center">{l.icon}</span>
            {l.label}
          </Link>
        );
      })}
      <div className="mt-auto px-3 text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
        Script → segments → Gemini images → Ken Burns + particles → voiceover + music → MP4
      </div>
    </aside>
  );
}
