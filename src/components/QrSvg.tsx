"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Real, scannable QR code rendered as inline SVG. */
export function QrSvg({ value, className }: { value: string; className?: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1f2933", light: "#ffffff" } }).then(setSvg);
  }, [value]);
  return <div className={className} role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}
