"use client";

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import maplibregl, { type Map as MLMap, type EaseToOptions } from "maplibre-gl";

export type MapRef = {
  easeTo: (options: EaseToOptions) => void;
};

type MapProps = {
  center?: [number, number];
  zoom?: number;
};

const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/dark";

const MapComponent = forwardRef<MapRef, MapProps>(function MapComponent(
  { center = [0, 0], zoom = 12 },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);

  useImperativeHandle(ref, () => ({
    easeTo: (options) => mapRef.current?.easeTo(options),
  }));

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DEFAULT_STYLE,
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

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
});

export { MapComponent as Map };
export default MapComponent;
