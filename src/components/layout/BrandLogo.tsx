interface BrandLogoProps {
  className?: string;
  /** Empty by default: the mark is decorative next to the "Treasury Guild" text. */
  alt?: string;
}

/**
 * Treasury Guild logo mark. The drawing is `public/logo.svg` (strokes in
 * `currentColor`). An `<img>` cannot inherit color, so the mark is a mask
 * painted with the text color: near-black in light mode, near-white in dark,
 * with no JavaScript and no hydration flicker. Discord webhook avatars still
 * use `public/logo-white.png`.
 */
export function BrandLogo({ className, alt = "" }: BrandLogoProps) {
  const decorative = alt === "";
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : alt}
      aria-hidden={decorative ? true : undefined}
      className={`brand-logo ${className ?? ""}`}
    />
  );
}
