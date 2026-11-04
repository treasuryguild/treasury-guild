interface MeshCreditProps {
  /** Logo only. The collapsed sidebar has no room for the wordmark. */
  compact?: boolean;
}

/**
 * "Powered by Mesh" credit. The marks are the official black and white
 * SVGs from https://meshjs.dev/about/branding (public/mesh-logo-*.svg),
 * unmodified. `<picture>` follows `prefers-color-scheme` with no
 * JavaScript, the same way BrandLogo does.
 */
export function MeshCredit({ compact = false }: MeshCreditProps) {
  return (
    <a
      href="https://meshjs.dev/"
      target="_blank"
      rel="noopener noreferrer"
      title={compact ? "Powered by Mesh" : undefined}
      className={`mesh-credit ${compact ? "mesh-credit-compact" : ""}`}
    >
      <picture>
        <source srcSet="/mesh-logo-white.svg" media="(prefers-color-scheme: dark)" />
        {/* Plain <img>: next/image has no <picture>/<source> support. */}
        <img
          src="/mesh-logo-black.svg"
          alt=""
          className="mesh-credit-mark"
          draggable={false}
          decoding="async"
        />
      </picture>
      <span className={compact ? "sr-only" : undefined}>Powered by Mesh</span>
    </a>
  );
}
