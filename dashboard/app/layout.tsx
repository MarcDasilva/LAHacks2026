import React from "react";
import type { Metadata } from "next";
import {
  Instrument_Sans,
  Instrument_Serif,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "IMPULSE | Real-Time Product Command Center",
  description:
    "IMPULSE helps teams capture live operational signals, prioritize what matters, and coordinate response from one real-time workspace.",
  keywords: [
    "IMPULSE",
    "incident response",
    "command center",
    "live alerts",
    "first responder intelligence",
    "real-time operations",
    "emergency coordination",
  ],
  openGraph: {
    title: "IMPULSE | Real-Time Product Command Center",
    description:
      "Unify alerts, priorities, and execution in one system built for high-stakes operations.",
    type: "website",
    siteName: "IMPULSE",
  },
  twitter: {
    card: "summary_large_image",
    title: "IMPULSE | Real-Time Product Command Center",
    description:
      "Turn real-time field signals into aligned, decisive team action.",
  },
  applicationName: "IMPULSE",
  category: "technology",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
