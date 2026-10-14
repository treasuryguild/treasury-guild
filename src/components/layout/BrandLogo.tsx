interface BrandLogoProps {
  className?: string;
  /** Empty by default: the mark is decorative next to the "Treasury Guild" text. */
  alt?: string;
}

/**
 * Treasury Guild logo mark. Serves the black outline on light themes and the
 * white outline on dark themes via `<picture>`, so the swap follows the
 * active `prefers-color-scheme` with no JavaScript and no hydration flicker.
 * Source files live in `public/logo-black.png` and `public/logo-white.png`.
 */
export function BrandLogo({ className, alt = "" }: BrandLogoProps) {
  return (
    <picture>
      <source srcSet="/logo-white.png" media="(prefers-color-scheme: dark)" />
      {/* Plain <img>: next/image has no <picture>/<source> support. */}
      <img
        src="/logo-black.png"
        alt={alt}
        className={className}
        draggable={false}
        decoding="async"
      />
    </picture>
  );
}
