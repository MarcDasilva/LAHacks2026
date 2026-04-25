"use client";

import dynamic from "next/dynamic";

const AlertsClient = dynamic(() => import("./AlertsClient"), { ssr: false });

export default function AlertsWrapper() {
  return <AlertsClient />;
}
