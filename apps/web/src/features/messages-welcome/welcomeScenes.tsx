/**
 * MSG-WELCOME-3D-01: original isometric scenes for the Messages welcome
 * carousel. Every detail is constructed here from primitive shapes through a
 * 30° isometric projection (`iso`) and three face planes (`onPlane`); no
 * outline, path or composition is taken from third-party artwork.
 *
 * Each scene is a list of independent parts. A part is one decorative SVG
 * placed at its own depth (`--z`) inside a `preserve-3d` scene, so the
 * carousel can float, tilt and assemble every detail separately.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";

export type WelcomeSceneId =
  "chat" | "room" | "whiteboard" | "files" | "calendar" | "code";

type Vec3 = readonly [number, number, number];
type Plane = "top" | "left" | "right";
type PartStyle = CSSProperties & Record<`--${string}`, string>;

const COS30 = 0.866;

function round(value: number) {
  return Math.round(value * 10) / 10;
}

/** Screen position of a 3D point: +x runs right-down, +y left-down, +z up. */
function iso([x, y, z]: Vec3): [number, number] {
  return [round((x - y) * COS30), round((x + y) / 2 - z)];
}

function points(...vertices: Vec3[]) {
  return vertices.map((vertex) => iso(vertex).join(",")).join(" ");
}

/**
 * Maps flat 2D drawing coordinates (u right, w down) onto a face plane:
 * `top` lies on the ground, `left` faces front-left (+y), `right` faces
 * front-right (+x).
 */
const planeMatrix: Record<Plane, string> = {
  left: "0.866 0.5 0 1",
  right: "0.866 -0.5 0 1",
  top: "0.866 0.5 -0.866 0.5",
};

function onPlane(plane: Plane, origin: Vec3) {
  const [x, y] = iso(origin);
  return `matrix(${planeMatrix[plane]} ${x} ${y})`;
}

function viewBoxOf(min: Vec3, max: Vec3, pad = 5) {
  const left = (min[0] - max[1]) * COS30;
  const right = (max[0] - min[1]) * COS30;
  const top = (min[0] + min[1]) / 2 - max[2];
  const bottom = (max[0] + max[1]) / 2 - min[2];
  return [left - pad, top - pad, right - left + pad * 2, bottom - top + pad * 2]
    .map(round)
    .join(" ");
}

function Art({ children, viewBox }: { children: ReactNode; viewBox: string }) {
  return (
    <svg
      aria-hidden="true"
      className="mw-svg"
      focusable="false"
      viewBox={viewBox}
    >
      {children}
    </svg>
  );
}

/** A solid block with its three visible faces (light from the top-left). */
function Box({
  at: [x, y, z],
  left = "mw-f1",
  right = "mw-f2",
  size: [w, d, h],
  top = "mw-f0",
}: {
  at: Vec3;
  left?: string;
  right?: string;
  size: Vec3;
  top?: string;
}) {
  return (
    <>
      <polygon
        className={right}
        points={points(
          [x + w, y, z],
          [x + w, y + d, z],
          [x + w, y + d, z + h],
          [x + w, y, z + h],
        )}
      />
      <polygon
        className={left}
        points={points(
          [x, y + d, z],
          [x + w, y + d, z],
          [x + w, y + d, z + h],
          [x, y + d, z + h],
        )}
      />
      <polygon
        className={top}
        points={points(
          [x, y, z + h],
          [x + w, y, z + h],
          [x + w, y + d, z + h],
          [x, y + d, z + h],
        )}
      />
    </>
  );
}

/**
 * Gives a flat outline some thickness: an outlined back copy, filled
 * in-between copies for the edge band, then the front face on top.
 */
function Extrude({
  children,
  face,
  frame,
  offset: [dx, dy],
  shape,
  side = "mw-f2",
}: {
  children?: ReactNode;
  face: string;
  frame?: string;
  offset: readonly [number, number];
  shape: (className: string) => ReactNode;
  side?: string;
}) {
  const steps = 4;
  return (
    <>
      {[4, 3, 2, 1].map((step) => (
        <g
          key={step}
          transform={`translate(${round((dx * step) / steps)} ${round((dy * step) / steps)})`}
        >
          <g transform={frame}>{shape(step === steps ? side : "mw-band")}</g>
        </g>
      ))}
      <g transform={frame}>
        {shape(face)}
        {children}
      </g>
    </>
  );
}

function gearPath(center: number, outer: number, inner: number, teeth = 9) {
  const step = (Math.PI * 2) / teeth;
  const corners: string[] = [];
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const angle = tooth * step;
    for (const [offset, radius] of [
      [-0.26, inner],
      [-0.15, outer],
      [0.15, outer],
      [0.26, inner],
    ] as const) {
      const a = angle + offset * step;
      corners.push(
        `${round(center + Math.cos(a) * radius)},${round(center + Math.sin(a) * radius)}`,
      );
    }
  }
  return `M${corners.join("L")}Z`;
}

const GEAR = gearPath(28, 25, 19);

/* ---------- Reusable details ---------- */

function PersonGlyph({
  cx,
  cy,
  fill,
}: {
  cx: number;
  cy: number;
  fill: string;
}) {
  return (
    <>
      <circle className={fill} cx={cx} cy={cy - 3.5} r="4.5" />
      <path className={fill} d={`M${cx - 9} ${cy + 10}a9 8 0 0 1 18 0Z`} />
    </>
  );
}

const gearArt = (
  <Art viewBox="-2 -2 66 66">
    <Extrude
      face="mw-f1"
      offset={[4, 4]}
      shape={(className) => (
        <g className="mw-spin">
          <path className={className} d={GEAR} />
        </g>
      )}
    >
      <circle className="mw-lime" cx="28" cy="28" r="9" />
      <circle className="mw-f0" cx="28" cy="28" r="4" />
    </Extrude>
  </Art>
);

const syncArt = (
  <Art viewBox="-2 -2 72 72">
    <Extrude
      face="mw-f0"
      offset={[4, 4]}
      shape={(className) => (
        <circle className={className} cx="32" cy="32" r="27" />
      )}
    />
    <g className="mw-spin mw-spin--reverse">
      <path className="mw-glyph" d="M16.5 28.5A16 16 0 0 1 44.5 21" />
      <path className="mw-glyph" d="M45 13.5v8h-8" />
      <path className="mw-glyph" d="M47.5 35.5A16 16 0 0 1 19.5 43" />
      <path className="mw-glyph" d="M19 50.5v-8h8" />
    </g>
  </Art>
);

function cursorArt(fill: string, tag: string) {
  return (
    <Art viewBox="-3 -3 58 52">
      <Extrude
        face={fill}
        offset={[2.5, 2.5]}
        shape={(className) => (
          <path
            className={className}
            d="M2 2V31L9.5 24.5 15 35.5 20.5 33 15 22H25Z"
          />
        )}
      />
      <rect className={tag} height="11" rx="5.5" width="30" x="21" y="34" />
      <path className="mw-soft" d="M27 39.5h17" />
    </Art>
  );
}

const sparkles = {
  plus: (
    <Art viewBox="0 0 16 16">
      <g className="mw-spin-slow">
        <path className="mw-hole" d="M8 2v12M2 8h12" />
      </g>
    </Art>
  ),
  ring: (
    <Art viewBox="0 0 16 16">
      <circle className="mw-hole" cx="8" cy="8" r="5" />
    </Art>
  ),
  star: (
    <Art viewBox="0 0 16 16">
      <g className="mw-spin-slow">
        <path
          className="mw-lime"
          d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z"
        />
      </g>
    </Art>
  ),
} as const;

/* ---------- Scene 1: class chat & direct messages ---------- */

const phoneArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [60, 9, 112])}>
    <Box at={[0, 0, 0]} left="mw-f1" size={[60, 9, 112]} top="mw-f1" />
    <g transform={onPlane("left", [0, 9, 112])}>
      <path className="mw-soft" d="M25 4.5h10" />
      <rect className="mw-f0" height="94" rx="3" width="50" x="5" y="9" />
      <rect className="mw-brand" height="11" rx="3" width="50" x="5" y="9" />
      <circle className="mw-f0" cx="12" cy="14.5" r="3" />
      <path className="mw-soft" d="M18 14.5h16" />
      <rect className="mw-f1" height="10" rx="5" width="28" x="9" y="26" />
      <rect className="mw-lime" height="10" rx="5" width="28" x="23" y="40" />
      <rect className="mw-f1" height="15" rx="5" width="34" x="9" y="54" />
      <rect className="mw-lime" height="10" rx="5" width="24" x="27" y="73" />
      <rect className="mw-f0" height="9" rx="4.5" width="34" x="9" y="89" />
      <circle className="mw-accent" cx="48" cy="93.5" r="4" />
    </g>
  </Art>
);

const bubbleArt = (
  <Art viewBox={viewBoxOf([-7, 0, 0], [0, 72, 56])}>
    <Extrude
      face="mw-f0"
      frame={onPlane("right", [0, 72, 56])}
      offset={[-6, -3.5]}
      shape={(className) => (
        <path
          className={className}
          d="M10 0H62A10 10 0 0 1 72 10V36A10 10 0 0 1 62 46H28L15 56 17 46H10A10 10 0 0 1 0 36V10A10 10 0 0 1 10 0Z"
        />
      )}
    >
      <circle className="mw-accent" cx="23" cy="23" r="4.5" />
      <circle className="mw-brand" cx="36" cy="23" r="4.5" />
      <circle className="mw-lime" cx="49" cy="23" r="4.5" />
    </Extrude>
  </Art>
);

const classCardArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [66, 5, 44])}>
    <Box at={[0, 0, 0]} left="mw-f0" size={[66, 5, 44]} />
    <g transform={onPlane("left", [0, 5, 44])}>
      <circle className="mw-brand" cx="13" cy="15" r="7.5" />
      <circle className="mw-lime" cx="23" cy="15" r="7.5" />
      <circle className="mw-f1" cx="33" cy="15" r="7.5" />
      <circle className="mw-f0" cx="33" cy="13" r="2.5" />
      <rect className="mw-f2" height="8" rx="4" width="14" x="45" y="11" />
      <path className="mw-soft" d="M8 30h36M8 37h24" />
    </g>
  </Art>
);

const paperPlaneArt = (
  <Art viewBox="-3 -1 74 64">
    <polygon className="mw-lime" points="26,38 66,4 36,58" />
    <polygon className="mw-f2" points="26,38 36,58 29,45" />
    <polygon className="mw-f0" points="0,28 66,4 26,38" />
  </Art>
);

/* ---------- Scene 2: online classroom ---------- */

const videoTiles = [
  { fill: "mw-brand", glyph: "mw-f0", x: 7, y: 7 },
  { fill: "mw-f0", glyph: "mw-f2", x: 50, y: 7 },
  { fill: "mw-f0", glyph: "mw-f2", x: 7, y: 36 },
  { fill: "mw-lime", glyph: "mw-f0", x: 50, y: 36 },
] as const;

const monitorArt = (
  <Art viewBox={viewBoxOf([-14, 0, 0], [18, 98, 106])}>
    <Box at={[-14, 30, 0]} size={[32, 40, 6]} />
    <Box at={[0, 44, 6]} size={[6, 12, 30]} />
    <Box at={[0, 0, 36]} right="mw-f0" size={[10, 98, 70]} />
    <g transform={onPlane("right", [10, 98, 106])}>
      <rect className="mw-f1" height="60" rx="2" width="88" x="5" y="5" />
      {videoTiles.map((tile) => (
        <Fragment key={`${tile.x}-${tile.y}`}>
          <rect
            className={tile.fill}
            height="27"
            rx="3"
            width="41"
            x={tile.x}
            y={tile.y}
          />
          <PersonGlyph cx={tile.x + 20.5} cy={tile.y + 14} fill={tile.glyph} />
        </Fragment>
      ))}
    </g>
  </Art>
);

const webcamArt = (
  <Art viewBox={viewBoxOf([0, 0, -7], [18, 26, 16])}>
    <Box at={[6, 9, -7]} size={[6, 8, 7]} />
    <Box at={[0, 0, 0]} size={[18, 26, 16]} />
    <g transform={onPlane("left", [0, 26, 16])}>
      <circle className="mw-f0" cx="9" cy="8" r="5.5" />
      <circle className="mw-accent" cx="9" cy="8" r="2.6" />
    </g>
  </Art>
);

const shareCardArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [60, 5, 44])}>
    <Box at={[0, 0, 0]} left="mw-f0" size={[60, 5, 44]} />
    <g transform={onPlane("left", [0, 5, 44])}>
      <path className="mw-soft" d="M0 9h60" />
      <circle className="mw-f2" cx="5" cy="4.5" r="1.6" />
      <circle className="mw-f2" cx="10" cy="4.5" r="1.6" />
      <circle className="mw-f2" cx="15" cy="4.5" r="1.6" />
      <rect className="mw-f1" height="26" rx="2" width="44" x="8" y="13" />
      <rect className="mw-lime" height="16" rx="3" width="16" x="22" y="18" />
      <path className="mw-glyph" d="M30 30v-8M26.5 25.5 30 22l3.5 3.5" />
    </g>
  </Art>
);

const micArt = (
  <Art viewBox="0 0 50 62">
    <Extrude
      face="mw-f0"
      offset={[3, 3]}
      shape={(className) => (
        <rect
          className={className}
          height="32"
          rx="10"
          width="20"
          x="14"
          y="4"
        />
      )}
    >
      <path className="mw-soft" d="M19 14h10M19 20h10M19 26h10" />
    </Extrude>
    <path className="mw-hole" d="M8 24a16 16 0 0 0 32 0M24 40v10" />
    <ellipse className="mw-lime" cx="24" cy="54" rx="12" ry="4" />
  </Art>
);

const signalArt = (
  <Art viewBox="0 0 54 54">
    <Extrude
      face="mw-brand"
      offset={[3, 3]}
      shape={(className) => (
        <rect
          className={className}
          height="44"
          rx="11"
          width="44"
          x="3"
          y="3"
        />
      )}
    >
      <rect className="mw-f0" height="10" rx="1.5" width="6" x="13" y="28" />
      <rect className="mw-f0" height="17" rx="1.5" width="6" x="22" y="21" />
      <rect className="mw-lime" height="25" rx="1.5" width="6" x="31" y="13" />
    </Extrude>
  </Art>
);

/* ---------- Scene 3: collaborative whiteboard ---------- */

const boardArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [112, 16, 104])}>
    <Box at={[14, 2, 0]} size={[4, 4, 34]} />
    <Box at={[94, 2, 0]} size={[4, 4, 34]} />
    <Box at={[0, 0, 32]} size={[112, 7, 72]} top="mw-f1" />
    <g transform={onPlane("left", [0, 7, 104])}>
      <rect className="mw-f0" height="60" rx="2" width="102" x="5" y="5" />
      <circle className="mw-lime" cx="30" cy="23" r="8" />
      <path className="mw-ink-line" d="M14 50C24 20 36 18 46 34S68 58 82 26" />
      <polygon className="mw-f1" points="70,56 82,38 94,56" />
      <path className="mw-soft" d="M84 14h16M88 21h12" />
    </g>
    <Box at={[10, 7, 30]} size={[92, 9, 3]} />
  </Art>
);

const markerArt = (
  <Art viewBox="0 4 76 54">
    <g transform="translate(8 40) rotate(-28)">
      <polygon className="mw-f2" points="0,3 -7,6 0,9" />
      <Extrude
        face="mw-f0"
        offset={[2, 3]}
        shape={(className) => (
          <rect
            className={className}
            height="12"
            rx="4"
            width="62"
            x="0"
            y="0"
          />
        )}
      >
        <rect
          className="mw-accent"
          height="12"
          rx="4"
          width="18"
          x="44"
          y="0"
        />
        <path className="mw-soft" d="M9 6h26" />
      </Extrude>
    </g>
  </Art>
);

const stickyArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [3, 42, 42])}>
    <Box at={[0, 0, 0]} left="mw-f2" right="mw-lime" size={[3, 42, 42]} />
    <g transform={onPlane("right", [3, 42, 42])}>
      <polygon className="mw-f0" points="30,42 42,30 30,30" />
      <path className="mw-soft" d="M7 10h26M7 17h22M7 24h14" />
    </g>
  </Art>
);

const cubeArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [26, 26, 26])}>
    <Box at={[0, 0, 0]} size={[26, 26, 26]} top="mw-lime" />
  </Art>
);

/* ---------- Scene 4: documents & PDF presenting ---------- */

const sheetStackArt = (
  <Art viewBox={viewBoxOf([0, -10, 0], [70, 78, 10])}>
    <Box at={[0, 0, 0]} size={[60, 78, 2]} top="mw-f1" />
    <Box at={[5, -5, 4]} size={[60, 78, 2]} />
    <Box at={[10, -10, 8]} size={[60, 78, 2]} />
    <g transform={onPlane("top", [10, -10, 10])}>
      <rect className="mw-lime" height="10" rx="2" width="22" x="6" y="6" />
      <path className="mw-soft" d="M6 26h46M6 34h40M6 42h46" />
      <rect className="mw-brand" height="20" rx="2" width="30" x="6" y="50" />
      <path className="mw-hole" d="M9 68l8-8 6 5 5-4 6 7" />
    </g>
  </Art>
);

const projectorArt = (
  <Art viewBox={viewBoxOf([-12, -2, 0], [16, 86, 105])}>
    <polyline className="mw-hole" points={points([4, 42, 46], [4, 42, 0])} />
    <polyline
      className="mw-hole"
      points={points([-10, 30, 0], [4, 42, 14], [16, 54, 0])}
    />
    <Box at={[0, 0, 44]} right="mw-f0" size={[4, 84, 56]} />
    <Box at={[-2, -2, 100]} size={[8, 88, 5]} top="mw-f1" />
    <g transform={onPlane("right", [4, 84, 100])}>
      <path className="mw-soft" d="M10 49H74" />
      <rect
        className="mw-brand"
        height="18"
        rx="1.5"
        width="10"
        x="14"
        y="31"
      />
      <rect className="mw-lime" height="30" rx="1.5" width="10" x="30" y="19" />
      <rect
        className="mw-brand"
        height="22"
        rx="1.5"
        width="10"
        x="46"
        y="27"
      />
      <rect
        className="mw-accent"
        height="36"
        rx="1.5"
        width="10"
        x="62"
        y="13"
      />
    </g>
  </Art>
);

const pagerArt = (
  <Art viewBox="0 0 80 34">
    <Extrude
      face="mw-f0"
      offset={[2.5, 3]}
      shape={(className) => (
        <rect
          className={className}
          height="26"
          rx="13"
          width="72"
          x="2"
          y="2"
        />
      )}
    >
      <path className="mw-glyph" d="M17 9l-6 6 6 6M59 9l6 6-6 6" />
      <circle className="mw-f2" cx="28" cy="15" r="2.5" />
      <rect
        className="mw-lime"
        height="5"
        rx="2.5"
        width="11"
        x="33"
        y="12.5"
      />
      <circle className="mw-f2" cx="49" cy="15" r="2.5" />
    </Extrude>
  </Art>
);

const magnifierArt = (
  <Art viewBox="0 0 66 66">
    <g transform="translate(38 38) rotate(45)">
      <rect
        className="mw-accent"
        height="9"
        rx="4.5"
        width="24"
        x="0"
        y="-4.5"
      />
    </g>
    <Extrude
      face="mw-f0"
      offset={[3, 3]}
      shape={(className) => (
        <circle className={className} cx="26" cy="26" r="17" />
      )}
    >
      <circle className="mw-brand" cx="26" cy="26" r="11.5" />
      <path className="mw-soft" d="M19 21a9 9 0 0 1 7-5" />
    </Extrude>
  </Art>
);

const folderArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [58, 9, 46])}>
    <Box at={[0, 0, 40]} left="mw-f1" size={[22, 5, 6]} />
    <Box at={[0, 0, 0]} size={[58, 5, 40]} />
    <Box at={[0, 5, 0]} left="mw-lime" size={[58, 4, 34]} />
    <g transform={onPlane("left", [0, 9, 34])}>
      <path className="mw-soft" d="M8 10h18" />
    </g>
  </Art>
);

/* ---------- Scene 5: schedule & reminders ---------- */

const calendarCells = [0, 1, 2].flatMap((row) =>
  [0, 1, 2, 3].map((column) => ({
    fill:
      row === 1 && column === 1
        ? "mw-lime"
        : row === 0 && column === 3
          ? "mw-brand"
          : "mw-f1",
    key: `${row}-${column}`,
    x: 7 + column * 17,
    y: 21 + row * 13,
  })),
);

const deskCalendarArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [80, 16, 70])}>
    <Box at={[0, 0, 0]} left="mw-f0" size={[80, 16, 64]} top="mw-f1" />
    <g transform={onPlane("left", [0, 16, 64])}>
      <rect className="mw-brand" height="14" width="80" x="0" y="0" />
      <rect className="mw-f0" height="10" rx="2" width="4" x="16" y="-5" />
      <rect className="mw-f0" height="10" rx="2" width="4" x="60" y="-5" />
      {calendarCells.map((cell) => (
        <rect
          className={cell.fill}
          height="10"
          key={cell.key}
          rx="2"
          width="14"
          x={cell.x}
          y={cell.y}
        />
      ))}
    </g>
  </Art>
);

const clockArt = (
  <Art viewBox="0 0 68 70">
    <path className="mw-lime" d="M8 18A10 10 0 0 1 20 6Z" />
    <path className="mw-lime" d="M56 18A10 10 0 0 0 44 6Z" />
    <path className="mw-hole" d="M18 56l-5 7M46 56l5 7" />
    <Extrude
      face="mw-f0"
      offset={[3, 3]}
      shape={(className) => (
        <circle className={className} cx="32" cy="34" r="23" />
      )}
    >
      <path className="mw-soft" d="M32 15v4M32 49v4M13 34h4M47 34h4" />
      <g className="mw-spin-slow">
        <circle className="mw-ghost" cx="32" cy="34" r="14" />
        <path className="mw-glyph" d="M32 34V24" />
      </g>
      <g className="mw-spin">
        <circle className="mw-ghost" cx="32" cy="34" r="17" />
        <path className="mw-accent-line" d="M32 34H47" />
      </g>
      <circle className="mw-accent" cx="32" cy="34" r="2.5" />
    </Extrude>
  </Art>
);

const bellArt = (
  <Art viewBox="0 0 54 54">
    <g className="mw-swing">
      <path className="mw-hole" d="M19 42a5 5 0 0 0 10 0" />
      <Extrude
        face="mw-f0"
        offset={[2.5, 2.5]}
        shape={(className) => (
          <path
            className={className}
            d="M24 7c-8.5 0-13.5 6.5-13.5 15.5v8L5 38h38l-5.5-7.5v-8C37.5 13.5 32.5 7 24 7Z"
          />
        )}
      />
      <circle className="mw-f0" cx="24" cy="5" r="2.5" />
    </g>
    <circle className="mw-lime" cx="40" cy="11" r="6" />
  </Art>
);

const bookedCardArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [4, 58, 38])}>
    <Box at={[0, 0, 0]} left="mw-f2" right="mw-f0" size={[4, 58, 38]} />
    <g transform={onPlane("right", [4, 58, 38])}>
      <rect className="mw-lime" height="15" rx="3" width="15" x="7" y="11" />
      <path className="mw-glyph" d="M10.5 18.5l3.5 3.5 6-7" />
      <path className="mw-soft" d="M28 15h22M28 22h16" />
    </g>
  </Art>
);

/* ---------- Scene 6: coding in class ---------- */

const codeRows = [
  { fill: "mw-accent", w: 22, x: 18, y: 20 },
  { fill: "mw-brand", w: 30, x: 44, y: 20 },
  { fill: "mw-f2", w: 34, x: 24, y: 28 },
  { fill: "mw-lime", w: 16, x: 62, y: 28 },
  { fill: "mw-brand", w: 18, x: 24, y: 36 },
  { fill: "mw-f2", w: 28, x: 46, y: 36 },
  { fill: "mw-lime", w: 40, x: 30, y: 44 },
  { fill: "mw-f2", w: 26, x: 24, y: 52 },
  { fill: "mw-accent", w: 14, x: 18, y: 60 },
  { fill: "mw-brand", w: 36, x: 36, y: 60 },
  { fill: "mw-f2", w: 20, x: 18, y: 68 },
] as const;

const editorArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [8, 104, 76])}>
    <Box at={[0, 0, 0]} right="mw-f0" size={[8, 104, 76]} top="mw-f1" />
    <g transform={onPlane("right", [8, 104, 76])}>
      <rect className="mw-f1" height="12" width="104" x="0" y="0" />
      <circle className="mw-lime" cx="7" cy="6" r="2.2" />
      <circle className="mw-f0" cx="14" cy="6" r="2.2" />
      <circle className="mw-f0" cx="21" cy="6" r="2.2" />
      <rect className="mw-f1" height="64" width="12" x="0" y="12" />
      {codeRows.map((row) => (
        <rect
          className={`${row.fill} mw-flat`}
          height="4"
          key={`${row.x}-${row.y}`}
          rx="2"
          width={row.w}
          x={row.x}
          y={row.y}
        />
      ))}
      <path className="mw-accent-line" d="M42 65v7" />
    </g>
  </Art>
);

const bracketsArt = (
  <Art viewBox="0 0 56 56">
    <Extrude
      face="mw-lime"
      offset={[3, 3]}
      shape={(className) => (
        <rect
          className={className}
          height="46"
          rx="12"
          width="46"
          x="3"
          y="3"
        />
      )}
    >
      <path
        className="mw-glyph"
        d="M19 17l-8 9 8 9M33 17l8 9-8 9M29 14l-6 24"
      />
    </Extrude>
  </Art>
);

const terminalArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [56, 5, 36])}>
    <Box at={[0, 0, 0]} left="mw-f2" size={[56, 5, 36]} top="mw-f1" />
    <g transform={onPlane("left", [0, 5, 36])}>
      <circle className="mw-f0" cx="5" cy="5" r="1.6" />
      <circle className="mw-f0" cx="10" cy="5" r="1.6" />
      <path className="mw-glyph" d="M8 14l6 5-6 5M18 26h12" />
    </g>
  </Art>
);

const runCubeArt = (
  <Art viewBox={viewBoxOf([0, 0, 0], [30, 30, 24])}>
    <Box at={[0, 0, 0]} left="mw-lime" size={[30, 30, 24]} />
    <g transform={onPlane("left", [0, 30, 24])}>
      <polygon className="mw-f0" points="11,6 11,18 21,12" />
    </g>
  </Art>
);

/* ---------- Scene composition ---------- */

interface ScenePart {
  art: ReactNode;
  /** Float height (px, negative = up), duration (s) and phase delay (s). */
  float: readonly [number, number, number];
  /** Assembly origin: x / y / z offset (px) and rotation (deg). */
  from: readonly [number, number, number, number];
  id: string;
  order: number;
  shadow?: boolean;
  w: number;
  x: number;
  y: number;
  z: number;
}

type Sparkle = readonly [keyof typeof sparkles, number, number, number];

function sparkleParts(list: readonly Sparkle[]): ScenePart[] {
  return list.map(([kind, x, y, z], index) => ({
    art: sparkles[kind],
    float: [-6, 5 + index, -1.7 * (index + 1)],
    from: [index % 2 === 0 ? -60 : 60, -40, 40, 90],
    id: `${kind}-${index}`,
    order: 2 + index,
    w: kind === "star" ? 4.4 : 3.4,
    x,
    y,
    z,
  }));
}

const scenes: Record<WelcomeSceneId, readonly ScenePart[]> = {
  chat: [
    {
      art: phoneArt,
      float: [-8, 6.2, -0.4],
      from: [0, 70, -90, -6],
      id: "phone",
      order: 0,
      shadow: true,
      w: 21,
      x: 33,
      y: 10,
      z: 0,
    },
    {
      art: bubbleArt,
      float: [-12, 5.2, -2.1],
      from: [120, -40, 60, 14],
      id: "bubble",
      order: 1,
      shadow: true,
      w: 23,
      x: 55,
      y: 6,
      z: 70,
    },
    {
      art: classCardArt,
      float: [-10, 5.8, -3.3],
      from: [110, 60, 20, -10],
      id: "class-card",
      order: 2,
      shadow: true,
      w: 24,
      x: 58,
      y: 54,
      z: 30,
    },
    {
      art: paperPlaneArt,
      float: [-14, 4.6, -1.2],
      from: [-140, -50, 80, -24],
      id: "paper-plane",
      order: 3,
      shadow: true,
      w: 17,
      x: 12,
      y: 16,
      z: 90,
    },
    {
      art: syncArt,
      float: [-7, 6.8, -4.4],
      from: [-110, 70, -40, 30],
      id: "sync",
      order: 4,
      shadow: true,
      w: 13,
      x: 15,
      y: 58,
      z: -30,
    },
    ...sparkleParts([
      ["plus", 86, 14, 40],
      ["ring", 7, 46, -20],
      ["star", 80, 86, 60],
    ]),
  ],
  room: [
    {
      art: monitorArt,
      float: [-7, 6.6, -0.8],
      from: [0, 80, -90, 0],
      id: "monitor",
      order: 0,
      shadow: true,
      w: 36,
      x: 26,
      y: 8,
      z: 0,
    },
    {
      art: webcamArt,
      float: [-10, 5.1, -2.4],
      from: [80, -80, 50, 18],
      id: "webcam",
      order: 1,
      shadow: true,
      w: 11,
      x: 63,
      y: 6,
      z: 60,
    },
    {
      art: shareCardArt,
      float: [-12, 5.6, -3.1],
      from: [130, 40, 70, -12],
      id: "share",
      order: 2,
      shadow: true,
      w: 23,
      x: 64,
      y: 44,
      z: 80,
    },
    {
      art: micArt,
      float: [-9, 4.8, -1.6],
      from: [-120, 60, 30, -16],
      id: "mic",
      order: 3,
      shadow: true,
      w: 10,
      x: 13,
      y: 52,
      z: 40,
    },
    {
      art: signalArt,
      float: [-13, 5.4, -4.2],
      from: [-100, -70, 80, 20],
      id: "signal",
      order: 4,
      shadow: true,
      w: 11,
      x: 12,
      y: 14,
      z: 90,
    },
    {
      art: gearArt,
      float: [-6, 6.9, -2.9],
      from: [70, -60, -40, 40],
      id: "gear",
      order: 5,
      shadow: true,
      w: 12,
      x: 80,
      y: 22,
      z: -20,
    },
    ...sparkleParts([
      ["plus", 6, 38, 30],
      ["star", 88, 72, 70],
      ["ring", 46, 90, -10],
    ]),
  ],
  whiteboard: [
    {
      art: boardArt,
      float: [-7, 6.4, -1.1],
      from: [0, 80, -80, 0],
      id: "board",
      order: 0,
      shadow: true,
      w: 39,
      x: 21,
      y: 6,
      z: 0,
    },
    {
      art: markerArt,
      float: [-11, 5.2, -2.6],
      from: [120, 70, 40, -30],
      id: "marker",
      order: 1,
      shadow: true,
      w: 18,
      x: 62,
      y: 64,
      z: 70,
    },
    {
      art: stickyArt,
      float: [-10, 5.8, -3.8],
      from: [110, -60, 50, 16],
      id: "sticky",
      order: 2,
      shadow: true,
      w: 12,
      x: 70,
      y: 14,
      z: 50,
    },
    {
      art: cursorArt("mw-accent", "mw-brand"),
      float: [-13, 4.7, -1.5],
      from: [60, -90, 90, -20],
      id: "cursor-a",
      order: 3,
      shadow: true,
      w: 11,
      x: 52,
      y: 30,
      z: 90,
    },
    {
      art: cursorArt("mw-f0", "mw-lime"),
      float: [-9, 5.5, -4.1],
      from: [-120, 50, 30, 18],
      id: "cursor-b",
      order: 4,
      shadow: true,
      w: 10,
      x: 22,
      y: 56,
      z: 30,
    },
    {
      art: cubeArt,
      float: [-8, 6.7, -2.2],
      from: [-90, -70, -40, -30],
      id: "cube",
      order: 5,
      shadow: true,
      w: 9,
      x: 6,
      y: 20,
      z: -30,
    },
    ...sparkleParts([
      ["star", 88, 46, 60],
      ["plus", 44, 86, 20],
      ["ring", 4, 76, -20],
    ]),
  ],
  files: [
    {
      art: sheetStackArt,
      float: [-7, 6.3, -0.6],
      from: [0, 90, -60, 0],
      id: "sheets",
      order: 0,
      shadow: true,
      w: 38,
      x: 30,
      y: 50,
      z: 0,
    },
    {
      art: projectorArt,
      float: [-6, 6.9, -2.5],
      from: [0, -80, -80, 0],
      id: "projector",
      order: 1,
      shadow: true,
      w: 27,
      x: 34,
      y: 2,
      z: 20,
    },
    {
      art: pagerArt,
      float: [-12, 5.1, -1.8],
      from: [130, 30, 60, 12],
      id: "pager",
      order: 2,
      shadow: true,
      w: 19,
      x: 66,
      y: 30,
      z: 80,
    },
    {
      art: magnifierArt,
      float: [-13, 4.8, -3.6],
      from: [-120, -60, 80, -24],
      id: "magnifier",
      order: 3,
      shadow: true,
      w: 13,
      x: 13,
      y: 14,
      z: 90,
    },
    {
      art: folderArt,
      float: [-9, 5.7, -4.3],
      from: [-110, 70, 30, 14],
      id: "folder",
      order: 4,
      shadow: true,
      w: 18,
      x: 9,
      y: 56,
      z: 50,
    },
    ...sparkleParts([
      ["plus", 88, 12, 40],
      ["star", 84, 74, 60],
      ["ring", 26, 42, -30],
    ]),
  ],
  calendar: [
    {
      art: deskCalendarArt,
      float: [-7, 6.4, -1.3],
      from: [0, 80, -80, 0],
      id: "desk-calendar",
      order: 0,
      shadow: true,
      w: 34,
      x: 28,
      y: 18,
      z: 0,
    },
    {
      art: clockArt,
      float: [-10, 5.4, -2.7],
      from: [110, -60, 50, 20],
      id: "clock",
      order: 1,
      shadow: true,
      w: 15,
      x: 64,
      y: 10,
      z: 60,
    },
    {
      art: bellArt,
      float: [-13, 4.9, -1.4],
      from: [-100, -80, 90, -20],
      id: "bell",
      order: 2,
      shadow: true,
      w: 11,
      x: 16,
      y: 10,
      z: 90,
    },
    {
      art: bookedCardArt,
      float: [-11, 5.9, -3.9],
      from: [120, 60, 40, -12],
      id: "booked",
      order: 3,
      shadow: true,
      w: 20,
      x: 64,
      y: 56,
      z: 40,
    },
    {
      art: syncArt,
      float: [-7, 6.8, -4.6],
      from: [-110, 70, -40, 30],
      id: "sync",
      order: 4,
      shadow: true,
      w: 12,
      x: 10,
      y: 58,
      z: -30,
    },
    ...sparkleParts([
      ["star", 90, 38, 70],
      ["plus", 46, 8, 30],
      ["ring", 38, 90, -20],
    ]),
  ],
  code: [
    {
      art: editorArt,
      float: [-7, 6.5, -0.9],
      from: [0, 80, -90, 0],
      id: "editor",
      order: 0,
      shadow: true,
      w: 42,
      x: 22,
      y: 8,
      z: 0,
    },
    {
      art: bracketsArt,
      float: [-12, 5.2, -2.2],
      from: [110, -70, 70, 22],
      id: "brackets",
      order: 1,
      shadow: true,
      w: 12,
      x: 68,
      y: 8,
      z: 80,
    },
    {
      art: terminalArt,
      float: [-10, 5.8, -3.4],
      from: [120, 60, 30, -14],
      id: "terminal",
      order: 2,
      shadow: true,
      w: 22,
      x: 63,
      y: 52,
      z: 40,
    },
    {
      art: runCubeArt,
      float: [-13, 4.6, -1.7],
      from: [-110, 60, 90, -18],
      id: "run",
      order: 3,
      shadow: true,
      w: 11,
      x: 13,
      y: 58,
      z: 90,
    },
    {
      art: gearArt,
      float: [-6, 6.9, -4.1],
      from: [-90, -70, -40, 40],
      id: "gear",
      order: 4,
      shadow: true,
      w: 12,
      x: 9,
      y: 16,
      z: -20,
    },
    {
      art: cursorArt("mw-f0", "mw-lime"),
      float: [-9, 5.5, -2.9],
      from: [60, 80, 60, 16],
      id: "cursor",
      order: 5,
      shadow: true,
      w: 9,
      x: 50,
      y: 46,
      z: 60,
    },
    ...sparkleParts([
      ["plus", 90, 40, 50],
      ["ring", 42, 88, -10],
      ["star", 4, 40, 70],
    ]),
  ],
};

function partStyle(part: ScenePart): PartStyle {
  const [amp, dur, delay] = part.float;
  const [fx, fy, fz, fr] = part.from;
  return {
    "--amp": `${amp}px`,
    "--delay": `${delay}s`,
    "--dur": `${dur}s`,
    "--fr": `${fr}deg`,
    "--fx": `${fx}px`,
    "--fy": `${fy}px`,
    "--fz": `${fz}px`,
    "--i": String(part.order),
    "--w": `${part.w}%`,
    "--x": `${part.x}%`,
    "--y": `${part.y}%`,
    "--z": `${part.z}px`,
  };
}

/** One floating 3D scene: every part is its own depth layer. */
export function WelcomeScene({ id }: { id: WelcomeSceneId }) {
  return (
    <div aria-hidden="true" className="mw-scene" data-scene={id}>
      {scenes[id].map((part) => (
        <div
          className="mw-part"
          data-part={part.id}
          key={part.id}
          style={partStyle(part)}
        >
          <div className="mw-part__enter">
            {part.shadow && <span className="mw-part__shadow" />}
            <div className="mw-part__float">{part.art}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
