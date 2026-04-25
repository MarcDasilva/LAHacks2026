"use client";

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import maplibregl, { type Map as MLMap, type EaseToOptions } from "maplibre-gl";

export type MapRef = {
  easeTo: (options: EaseToOptions) => void;
};

type MapStyles = { light: string; dark: string };

type MapProps = {
  center?: [number, number];
  zoom?: number;
  styles?: MapStyles;
};

const DEFAULT_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export const Map = forwardRef<MapRef, MapProps>(function Map(
  { center = [0, 0], zoom = 12, styles },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);

  useImperativeHandle(ref, () => ({
    easeTo: (options) => mapRef.current?.easeTo(options),
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;

    const styleUrl = styles
      ? prefersDark
        ? styles.dark
        : styles.light
      : DEFAULT_STYLE;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center,
      zoom,
      attributionControl: false,
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update style when prop changes
  useEffect(() => {
    if (!mapRef.current) return;
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const styleUrl = styles
      ? prefersDark
        ? styles.dark
        : styles.light
      : DEFAULT_STYLE;
    mapRef.current.setStyle(styleUrl);
  }, [styles]);

  return <div ref={containerRef} className="absolute inset-0" />;
});
