"use client";

import Link from "next/link";
import { LayoutDashboard, Bell, BarChart2, FileText } from "lucide-react";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard" },
  { icon: Bell,            label: "Alerts",    href: "/alerts" },
  { icon: BarChart2,       label: "Analytics", href: "#" },
  { icon: FileText,        label: "Reports",   href: "#" },
];

export default function Navbar() {
  return (
    <>
      {/* Top bar */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center px-6 h-[57px] bg-[var(--background)]/80 backdrop-blur-xl border-b border-[var(--border)]">
        <Link href="/" className="flex items-center gap-2 group hover:opacity-80 transition-opacity">
          <span className="font-display tracking-tight text-2xl">
            IMPULSE
          </span>
          <span className="text-[var(--muted-foreground)] font-display text-xs mt-1">
            OS
          </span>
        </Link>
      </nav>

      {/* Left sidebar */}
      <aside className="fixed top-[57px] left-0 bottom-0 z-40 w-14 flex flex-col items-center gap-1 pt-3 border-r border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-xl">
        {navItems.map(({ icon: Icon, label, href }) => (
          <a
            key={label}
            href={href}
            title={label}
            className="flex items-center justify-center w-10 h-10 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
          >
            <Icon size={17} strokeWidth={1.75} />
          </a>
        ))}
      </aside>
    </>
  );
}
