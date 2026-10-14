import { Inter } from "next/font/google";

import "~/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata = {
  title: "Kites",
  metadataBase: new URL("https://kites.social"),
};

export const viewport = {
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <head />
      <body>
        {children}
      </body>
    </html>
  );
}
