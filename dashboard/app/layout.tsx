import type { Metadata } from "next";
import { Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";
import Navbar from "./components/Navbar";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vigil",
  description: "LAHacks 2026",
  icons: { icon: "data:," },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${manrope.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
        <Navbar />
        <main className="pt-[57px] pl-14 h-full">{children}</main>
      </body>
    </html>
  );
}
