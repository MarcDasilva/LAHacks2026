"use client";

import { useEffect, useState } from "react";
import Dither from "@/components/Dither";

export default function DitherBackground() {
  const [docHeight, setDocHeight] = useState(1200);

  useEffect(() => {
    const updateHeight = () => {
      const body = document.body;
      const html = document.documentElement;
      const nextHeight = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );
      setDocHeight(nextHeight);
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);
    window.addEventListener("load", updateHeight);

    const ro = new ResizeObserver(updateHeight);
    ro.observe(document.body);
    ro.observe(document.documentElement);

    return () => {
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("load", updateHeight);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-0"
      style={{ height: `${docHeight}px` }}
      aria-hidden="true"
    >
      <Dither
        waveColor={[0.39215686274509803, 0.3843137254901961, 0.3843137254901961]}
        enableMouseInteraction={false}
        mouseRadius={0.3}
        colorNum={4}
        waveAmplitude={0.3}
        waveFrequency={3}
      />
    </div>
  );
}
