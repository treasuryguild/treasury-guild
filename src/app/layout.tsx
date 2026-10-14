import type { Metadata } from "next";
import { Providers } from "@/components/providers/Providers";
import { AppShell } from "@/components/layout/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Treasury Guild",
  description:
    "Cardano treasury manager for communities: multisig payouts for completed tasks",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
