import CameraFrameSender from "@/app/components/CameraFrameSender";

export default function CameraPage() {
  return (
    <div className="h-full w-full p-4">
      <div className="max-w-4xl">
        <h1 className="text-xl font-bold tracking-[-0.02em] mb-3">Camera Frame Source</h1>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          Start this source page to push JPEG frames to the dashboard stream panel.
        </p>
        <CameraFrameSender roomId="main-camera" maxWidth={1920} maxHeight={1080} maxFps={30} />
      </div>
    </div>
  );
}
