"use client";

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import maplibregl, { type Map as MLMap, type EaseToOptions } from "maplibre-gl";
import CameraFrameViewer from "@/app/components/CameraFrameViewer";

export type MapRef = {
  easeTo: (options: EaseToOptions) => void;
  highlightBuildingAt: (center: [number, number]) => void;
  showAlertPin: (center: [number, number]) => void;
};

type MapProps = {
  center?: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
};

const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/positron";
const BUILDINGS_LAYER_ID = "impulse-3d-buildings";
const BUILDING_SOURCE_ID = "openfreemap";
const BUILDING_SOURCE_LAYER = "building";
const BUILDING_HIGHLIGHT_SOURCE_ID = "impulse-building-highlight-source";
const BUILDING_HIGHLIGHT_FILL_LAYER_ID = "impulse-building-highlight-fill";
const BUILDING_HIGHLIGHT_OUTLINE_LAYER_ID = "impulse-building-highlight-outline";

function createAlertMarkerElement() {
  const markerEl = document.createElement("div");
  markerEl.className = "alert-pin-wrap";
  markerEl.innerHTML = `
    <div class="alert-modal-shell">
      <div class="alert-modal-preview">
        <div class="alert-modal-preview-mount"></div>
      </div>
      <div class="alert-modal-card">
        <div class="alert-modal-title">Suspicious activity detected</div>
        <div class="alert-modal-meta">Priority: Critical · Status: Live</div>
        <div class="alert-modal-location">301 Westwood Plaza, Los Angeles, CA 90095</div>
        <button class="alert-modal-connect" type="button">Connect</button>
      </div>
    </div>
    <div class="alert-pin-stem"></div>
    <div class="alert-pin-dot"></div>
  `;
  markerEl.addEventListener("pointerdown", (event) => event.stopPropagation());
  markerEl.addEventListener("click", (event) => event.stopPropagation());
  const connectButtonEl = markerEl.querySelector<HTMLButtonElement>(".alert-modal-connect");
  connectButtonEl?.addEventListener("click", (event) => {
    event.stopPropagation();
    window.location.assign("/dashboard?boot=1");
  });
  const previewMountEl = markerEl.querySelector<HTMLDivElement>(".alert-modal-preview-mount");
  if (!previewMountEl) {
    throw new Error("Alert preview container is missing.");
  }
  return { markerEl, previewMountEl };
}

function getGeometryCenter(geometry: GeoJSON.Geometry): [number, number] | null {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return null;

  const polygonRings =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0] ?? []]
      : geometry.coordinates.map((polygon) => polygon[0] ?? []);

  let bestRing: number[][] = [];
  let bestArea = 0;
  for (const ring of polygonRings) {
    if (ring.length < 4) continue;
    const area = Math.abs(getRingSignedArea(ring));
    if (area > bestArea) {
      bestArea = area;
      bestRing = ring;
    }
  }

  if (bestRing.length < 4) return null;
  return getRingCentroid(bestRing);
}

function getRingSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function getRingCentroid(ring: number[][]): [number, number] {
  let cx = 0;
  let cy = 0;
  let factorSum = 0;

  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const factor = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * factor;
    cy += (y1 + y2) * factor;
    factorSum += factor;
  }

  if (Math.abs(factorSum) < 1e-9) {
    return ring[0] as [number, number];
  }

  return [cx / (3 * factorSum), cy / (3 * factorSum)];
}

const MapComponent = forwardRef<MapRef, MapProps>(function MapComponent(
  { center = [0, 0], zoom = 12, pitch = 0, bearing = 0 },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const alertMarkerRef = useRef<maplibregl.Marker | null>(null);
  const alertPreviewRootRef = useRef<Root | null>(null);
  const highlightFadeRafRef = useRef<number | null>(null);
  const removeAlertMarker = () => {
    alertMarkerRef.current?.remove();
    alertPreviewRootRef.current?.unmount();
    alertPreviewRootRef.current = null;
    alertMarkerRef.current = null;
  };

  const ensureHighlightLayers = (map: MLMap) => {
    if (!map.getSource(BUILDING_HIGHLIGHT_SOURCE_ID)) {
      map.addSource(BUILDING_HIGHLIGHT_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });
    }

    if (!map.getLayer(BUILDING_HIGHLIGHT_FILL_LAYER_ID)) {
      map.addLayer({
        id: BUILDING_HIGHLIGHT_FILL_LAYER_ID,
        type: "fill",
        source: BUILDING_HIGHLIGHT_SOURCE_ID,
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.16,
        },
      });
    }

    if (!map.getLayer(BUILDING_HIGHLIGHT_OUTLINE_LAYER_ID)) {
      map.addLayer({
        id: BUILDING_HIGHLIGHT_OUTLINE_LAYER_ID,
        type: "line",
        source: BUILDING_HIGHLIGHT_SOURCE_ID,
        paint: {
          "line-color": "#ef4444",
          "line-width": 2,
          "line-opacity": 0.95,
        },
      });
    }
  };

  useImperativeHandle(ref, () => ({
    easeTo: (options) => mapRef.current?.easeTo(options),
    highlightBuildingAt: (center) => {
      const map = mapRef.current;
      if (!map) return;

      ensureHighlightLayers(map);

      const point = map.project(center);
      const features = map.queryRenderedFeatures(point, {
        layers: [BUILDINGS_LAYER_ID, "building"],
      });
      const target = features.find(
        (feature) =>
          feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon"
      );

      const source = map.getSource(BUILDING_HIGHLIGHT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;

      if (!target?.geometry) {
        source.setData({ type: "FeatureCollection", features: [] });
        return;
      }

      source.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: target.geometry,
          },
        ],
      });

      if (map.getLayer(BUILDING_HIGHLIGHT_FILL_LAYER_ID)) {
        map.setPaintProperty(BUILDING_HIGHLIGHT_FILL_LAYER_ID, "fill-opacity", 0.16);
      }
      removeAlertMarker();
    },
    showAlertPin: (center) => {
      const map = mapRef.current;
      if (!map) return;

      if (!alertMarkerRef.current) {
        const { markerEl, previewMountEl } = createAlertMarkerElement();
        const previewRoot = createRoot(previewMountEl);
        previewRoot.render(
          <div className="alert-modal-preview-frame">
            <CameraFrameViewer roomId="main-camera" />
          </div>
        );
        alertPreviewRootRef.current = previewRoot;

        alertMarkerRef.current = new maplibregl.Marker({
          element: markerEl,
          anchor: "bottom",
          offset: [0, -72],
        });
      }

      alertMarkerRef.current.setLngLat(center).addTo(map);
    },
  }));

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DEFAULT_STYLE,
      center,
      zoom,
      pitch,
      bearing,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    });

    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();

    const add3DBuildings = () => {
      if (map.getLayer(BUILDINGS_LAYER_ID)) return;

      const style = map.getStyle();
      if (!style || !Array.isArray(style.layers)) return;

      const firstSymbolLayer = style.layers.find((layer) => layer.type === "symbol")?.id;
      if (!map.getSource(BUILDING_SOURCE_ID)) {
        map.addSource(BUILDING_SOURCE_ID, {
          type: "vector",
          url: "https://tiles.openfreemap.org/planet",
        });
      }

      try {
        map.addLayer(
          {
            id: BUILDINGS_LAYER_ID,
            type: "fill-extrusion",
            source: BUILDING_SOURCE_ID,
            "source-layer": BUILDING_SOURCE_LAYER,
            minzoom: 12,
            filter: ["!=", ["get", "hide_3d"], true],
            paint: {
              "fill-extrusion-color": [
                "interpolate",
                ["linear"],
                ["get", "render_height"],
                0, "#fafbfd",
                200, "#f6f8fb",
                400, "#f1f4f8",
              ],
              "fill-extrusion-height": [
                "interpolate",
                ["linear"],
                ["zoom"],
                12,
                ["*", ["coalesce", ["get", "render_height"], ["get", "height"], 0], 0.08],
                13,
                ["*", ["coalesce", ["get", "render_height"], ["get", "height"], 0], 0.2],
                14,
                ["*", ["coalesce", ["get", "render_height"], ["get", "height"], 0], 0.45],
                16,
                ["coalesce", ["get", "render_height"], ["get", "height"], 0],
              ],
              "fill-extrusion-base": [
                "interpolate",
                ["linear"],
                ["zoom"],
                12,
                0,
                16,
                ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
              ],
              "fill-extrusion-opacity": 1,
            },
          },
          firstSymbolLayer
        );

        if (map.getLayer("building")) {
          map.setLayoutProperty("building", "visibility", "none");
        }
      } catch {
        // Ignore style-parse failures; map should remain usable even without extrusions.
      }
    };

    const selectBuilding = (lngLat: [number, number], geometry?: GeoJSON.Geometry | null) => {
      ensureHighlightLayers(map);
      const anchoredCenter = geometry ? getGeometryCenter(geometry) ?? lngLat : lngLat;

      const source = map.getSource(BUILDING_HIGHLIGHT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        if (geometry && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")) {
          source.setData({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry,
              },
            ],
          });
        } else {
          source.setData({ type: "FeatureCollection", features: [] });
        }
      }

      const animateHighlightOpacity = (from: number, to: number, durationMs: number, onDone: () => void) => {
        if (highlightFadeRafRef.current !== null) {
          window.cancelAnimationFrame(highlightFadeRafRef.current);
          highlightFadeRafRef.current = null;
        }

        map.setPaintProperty(BUILDING_HIGHLIGHT_FILL_LAYER_ID, "fill-opacity", from);
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / durationMs);
          const eased = 1 - Math.pow(1 - progress, 3);
          const value = from + (to - from) * eased;
          map.setPaintProperty(BUILDING_HIGHLIGHT_FILL_LAYER_ID, "fill-opacity", value);
          if (progress < 1) {
            highlightFadeRafRef.current = window.requestAnimationFrame(tick);
            return;
          }

          highlightFadeRafRef.current = null;
          onDone();
        };

        highlightFadeRafRef.current = window.requestAnimationFrame(tick);
      };

      if (!alertMarkerRef.current) {
        const { markerEl, previewMountEl } = createAlertMarkerElement();
        const previewRoot = createRoot(previewMountEl);
        previewRoot.render(
          <div className="alert-modal-preview-frame">
            <CameraFrameViewer roomId="main-camera" />
          </div>
        );
        alertPreviewRootRef.current = previewRoot;

        alertMarkerRef.current = new maplibregl.Marker({
          element: markerEl,
          anchor: "bottom",
          offset: [0, -72],
        });
      }

      alertMarkerRef.current.setLngLat(anchoredCenter).addTo(map);

      animateHighlightOpacity(0.16, 0.58, 360, () => {});
    };

    map.once("load", add3DBuildings);
    map.once("load", () => ensureHighlightLayers(map));
    map.on("click", (event) => {
      const point = event.point;
      const features = map.queryRenderedFeatures(point, { layers: [BUILDINGS_LAYER_ID, "building"] });
      const buildingFeature = features.find(
        (feature) =>
          feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon"
      );
      if (buildingFeature) {
        selectBuilding(
          [event.lngLat.lng, event.lngLat.lat],
          (buildingFeature.geometry as GeoJSON.Geometry | null | undefined) ?? null
        );
        return;
      }

      removeAlertMarker();
      const source = map.getSource(BUILDING_HIGHLIGHT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      source?.setData({ type: "FeatureCollection", features: [] });
      if (map.getLayer(BUILDING_HIGHLIGHT_FILL_LAYER_ID)) {
        map.setPaintProperty(BUILDING_HIGHLIGHT_FILL_LAYER_ID, "fill-opacity", 0.16);
      }
    });

    mapRef.current = map;

    return () => {
      if (highlightFadeRafRef.current !== null) {
        window.cancelAnimationFrame(highlightFadeRafRef.current);
        highlightFadeRafRef.current = null;
      }
      removeAlertMarker();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
});

export { MapComponent as Map };
export default MapComponent;
