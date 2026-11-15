"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";

const MOBILE_NAV = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
];

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  // Escape closes the mobile navigation without affecting desktop shortcuts.
  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  // Preload heavy usage charts in background when browser is idle
  useEffect(() => {
    const preload = () => {
      import("@/shared/components/UsageStats").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/UsageChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart").catch(() => {});
    };
    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(preload, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
      }
      const timer = setTimeout(preload, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <div className="flex h-screen h-dvh w-full min-w-0 overflow-hidden bg-bg">
      <div className="fixed right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[80] flex w-[min(92vw,380px)] flex-col gap-2 sm:right-4">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Sidebar - Mobile */}
      <div
        role="dialog"
        aria-label="Navigation"
        aria-modal={sidebarOpen ? "true" : undefined}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <main className="relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col transition-colors duration-300">
        {/* Faint grid background */}
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar ${pathname === "/dashboard/basic-chat" ? "" : "px-3 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6 lg:p-10"} ${pathname === "/dashboard/basic-chat" ? "flex flex-col overflow-hidden" : ""}`}>
          <div className={`${pathname === "/dashboard/basic-chat" ? "min-h-0 min-w-0 flex-1 w-full h-full flex flex-col" : pathname === "/dashboard/usage" ? "min-w-0 w-full" : "min-w-0 w-full max-w-7xl mx-auto"}`}>{children}</div>
        </div>
        {pathname !== "/dashboard/basic-chat" && (
          <nav aria-label="Quick navigation" className="z-10 grid shrink-0 grid-cols-4 border-t border-border-subtle bg-surface/95 px-1 pb-[max(0.3rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur-xl lg:hidden">
            {MOBILE_NAV.map((item) => {
              const active = pathname === item.href || (item.href === "/dashboard/endpoint" && pathname === "/dashboard") || pathname.startsWith(item.href + "/");
              return (
                <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-colors ${active ? "bg-primary/10 text-primary" : "text-text-muted hover:text-text-main"}`}>
                  <span aria-hidden="true" className="material-symbols-outlined text-[21px]">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </main>
    </div>
  );
}
