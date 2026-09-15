import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Exhibition Sales CRM",
  description: "Exhibitors, enquiries and follow-ups for the sales team",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
