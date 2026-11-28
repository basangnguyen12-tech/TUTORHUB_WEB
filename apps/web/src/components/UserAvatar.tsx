import { useId, useState } from "react";

/**
 * MSG-AVATAR-SEARCH-CLASSIN-01: shared person avatar. Without a photo it is a
 * Zalo-style default (neutral grey disc, solid white head-and-shoulders whose
 * shoulders are clipped by the circle's bottom arc). Drawn here as our own
 * SVG; it is always decorative because the name is shown next to it.
 */
export type UserAvatarSize = "xs" | "sm" | "md" | "lg";

export function UserAvatar({
  className,
  size = "sm",
  src,
}: {
  className?: string;
  size?: UserAvatarSize;
  /** Profile photo URL; the default silhouette is used when absent or broken. */
  src?: string | null;
}) {
  const clipID = `user-avatar-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const photo = src && src !== failedSrc ? src : null;

  return (
    <span
      aria-hidden="true"
      className={["user-avatar", `user-avatar--${size}`, className]
        .filter(Boolean)
        .join(" ")}
      data-avatar={photo ? "photo" : "default"}
    >
      {photo ? (
        <img
          alt=""
          className="user-avatar__photo"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(photo)}
          src={photo}
        />
      ) : (
        <svg
          className="user-avatar__figure"
          focusable="false"
          viewBox="0 0 40 40"
        >
          <defs>
            <clipPath id={clipID}>
              <circle cx="20" cy="20" r="20" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipID})`} fill="currentColor">
            <circle cx="20" cy="15.6" r="7.4" />
            <path d="M5.5 41C5.5 31.6 12 25.4 20 25.4S34.5 31.6 34.5 41Z" />
          </g>
        </svg>
      )}
    </span>
  );
}
