import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "XIE Spaces",
    short_name: "XIE Spaces",
    description: "Live campus map and room booking for Xavier Institute of Engineering",
    start_url: "/swipe",
    display: "standalone",
    background_color: "#f5f3ee",
    theme_color: "#1f2933",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
