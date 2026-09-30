import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Memory Map",
  description: "Pin your shared memories and wishlist spots across Europe.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
