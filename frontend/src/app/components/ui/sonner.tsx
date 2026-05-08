"use client";

import { Toaster as Sonner, ToasterProps } from "sonner";
import { useTheme as useAppTheme } from "@/app/appContexts";

const DEFAULT_OFFSET = { top: 72, right: 16 };

const Toaster = ({ position = "top-right", offset = DEFAULT_OFFSET, ...props }: ToasterProps) => {
  const appTheme = useAppTheme();
  const isDark = Boolean(appTheme?.isDarkMode);

  const bg = isDark ? "#ffffff" : "#0f172a";
  const text = isDark ? "#0f172a" : "#ffffff";
  const border = isDark ? "#e2e8f0" : "#1e3a8a";

  return (
    <Sonner
      theme={(props.theme ?? (isDark ? "dark" : "light")) as ToasterProps["theme"]}
      position={position}
      offset={offset}
      className="toaster group"
      style={
        {
          // Temporary theme swap per request:
          // - Light theme: dark-blue toast background.
          // - Dark theme: white toast background.
          "--normal-bg": bg,
          "--normal-text": text,
          "--normal-border": border,
          // Apply same palette to all toast variants for consistency.
          "--success-bg": bg,
          "--success-text": text,
          "--success-border": border,
          "--error-bg": bg,
          "--error-text": text,
          "--error-border": border,
          "--warning-bg": bg,
          "--warning-text": text,
          "--warning-border": border,
          "--info-bg": bg,
          "--info-text": text,
          "--info-border": border,
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
