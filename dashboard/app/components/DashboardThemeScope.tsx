"use client";

import { useEffect } from "react";

export default function DashboardThemeScope() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.classList.remove("dark");

    return () => {
      root.dataset.theme = "light";
      root.classList.remove("dark");
    };
  }, []);

  return null;
}
