"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils/cn";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className
}) {
  const widths = {
    sm: "w-full sm:w-[400px]",
    md: "w-full sm:w-[500px]",
    lg: "w-full sm:w-[600px]",
    xl: "w-full sm:w-[800px]",
    full: "w-full",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className={cn(
        "absolute right-0 top-0 flex h-full h-dvh max-w-full min-w-0 flex-col bg-surface",
        "shadow-[var(--shadow-elev)]",
        "slide-in-right",
        "border-l border-border-subtle",
        widths[width] || widths.md,
        className
      )}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-6">
          <div className="flex items-center gap-3">
            {title && (
              <h2 className="text-lg font-semibold text-text-main">{title}</h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] custom-scrollbar sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
