import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "EdgeTrace",
    short_name: "EdgeTrace",
    description: "Independent NFL player-prop analysis.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#18181b",
    theme_color: "#18181b",
    icons: [
      { src: "/icons/edgetrace-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/edgetrace-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/edgetrace-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
