import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import {
  classCoverThemes,
  type ClassCoverTheme,
} from "../app/classroomPreferences";
import { useI18n } from "../app/i18n";

/*
 * CLASS-CLASSIN-UI-01: ClassIn-style landscape covers drawn as inline SVG
 * (no network images). Every cover is decorative and hidden from assistive
 * technology; the class title always carries the meaning.
 */

type Stop = readonly [offset: number, color: string, opacity?: number];

function Gradient({
  id,
  stops,
  x2 = 0,
  y2 = 1,
}: {
  id: string;
  stops: readonly Stop[];
  x2?: number;
  y2?: number;
}) {
  return (
    <linearGradient id={id} x1="0" x2={x2} y1="0" y2={y2}>
      {stops.map(([offset, color, opacity]) => (
        <stop
          key={offset}
          offset={offset}
          stopColor={color}
          stopOpacity={opacity}
        />
      ))}
    </linearGradient>
  );
}

const stars = [
  [18, 22, 1.1],
  [44, 58, 0.8],
  [70, 18, 1.3],
  [96, 44, 0.7],
  [122, 14, 0.9],
  [150, 36, 1.2],
  [182, 20, 0.8],
  [206, 52, 1],
  [236, 16, 1.3],
  [262, 40, 0.8],
  [292, 24, 1.1],
  [308, 62, 0.7],
  [132, 70, 0.6],
  [58, 92, 0.7],
] as const;

function pines(
  xs: readonly number[],
  base: number,
  height: number,
  half: number,
  fill: string,
) {
  return xs.map((x) => (
    <path
      d={`M${x} ${base - height}L${x - half} ${base}H${x + half}Z`}
      fill={fill}
      key={x}
    />
  ));
}

function coverScene(theme: ClassCoverTheme, id: string): ReactNode {
  const sky = `${id}s`;
  const accent = `${id}a`;
  switch (theme) {
    case "starry-night":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#0b1026"],
                [0.55, "#1f1b4d"],
                [1, "#3b1f4f"],
              ]}
              x2={1}
            />
            <Gradient
              id={accent}
              stops={[
                [0, "#f59e0b", 0],
                [0.45, "#f472b6", 0.55],
                [0.7, "#a78bfa", 0.45],
                [1, "#60a5fa", 0],
              ]}
              x2={1}
              y2={0}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <path d="M-20 168L340 8V62L-20 206Z" fill={`url(#${accent})`} />
          {stars.map(([cx, cy, r]) => (
            <circle cx={cx} cy={cy} fill="#fff" key={cx} opacity=".85" r={r} />
          ))}
          <path d="M0 180V150Q80 128 160 146T320 140V180Z" fill="#05070f" />
          <circle cx="233.5" cy="121" fill="#05070f" r="2.6" />
          <rect
            fill="#05070f"
            height="18"
            rx="1.6"
            width="4.4"
            x="231.3"
            y="123"
          />
        </>
      );
    case "pastel-dawn":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#8ec5ff"],
                [0.55, "#c7b8f5"],
                [1, "#f6b8d1"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="248" cy="118" fill="#fff" opacity=".35" r="40" />
          <path
            d="M0 150Q100 132 200 148T320 142V180H0Z"
            fill="#fde2ef"
            opacity=".75"
          />
        </>
      );
    case "alpine-lake":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#cfe8f7"],
                [1, "#f4f1ea"],
              ]}
            />
            <Gradient
              id={accent}
              stops={[
                [0, "#22a59b"],
                [1, "#0f6e73"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <path
            d="M0 112L60 52 100 84 150 28 210 92 262 46 320 100V132H0Z"
            fill="#7b8794"
          />
          <path
            d="M150 28L136 44 150 40 162 46ZM262 46 250 58 263 55 274 60Z"
            fill="#fff"
          />
          <path
            d="M0 124L50 88 96 112 140 76 192 118 242 82 320 122V140H0Z"
            fill="#46664a"
          />
          <rect fill={`url(#${accent})`} height="54" width="320" y="126" />
          <path
            d="M40 146H112M168 158H262M92 168H150"
            stroke="#fff"
            strokeOpacity=".32"
            strokeWidth="2"
          />
        </>
      );
    case "golden-horizon":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#fde68a"],
                [0.55, "#f59e0b"],
                [1, "#c2410c"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="160" cy="118" fill="#fff7d6" opacity=".9" r="34" />
          <path
            d="M0 132Q70 106 150 128T320 118V180H0Z"
            fill="#7c2d12"
            opacity=".85"
          />
          <path d="M0 156Q110 136 210 156T320 150V180H0Z" fill="#431407" />
        </>
      );
    case "misty-pine":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#eef4f0"],
                [1, "#b7cbbf"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          {pines(
            [12, 44, 78, 120, 166, 204, 246, 288, 318],
            128,
            58,
            16,
            "#9fb6a8",
          )}
          <rect fill="#fff" height="40" opacity=".35" width="320" y="104" />
          {pines([28, 70, 110, 150, 196, 238, 280], 160, 74, 20, "#5f7f6d")}
          {pines([-4, 52, 132, 214, 300], 186, 82, 24, "#2f4f3f")}
        </>
      );
    case "minimal-studio":
      return (
        <>
          <rect fill="#f7f4ee" height="180" width="320" />
          <circle cx="72" cy="70" fill="#e9dcc6" r="44" />
          <rect
            fill="#fff"
            height="72"
            rx="10"
            stroke="#e2d8c8"
            width="112"
            x="172"
            y="38"
          />
          <rect fill="#d9cbb3" height="6" rx="3" width="62" x="188" y="58" />
          <rect fill="#e7dccb" height="6" rx="3" width="80" x="188" y="72" />
          <rect fill="#b9c8a9" height="6" rx="3" width="44" x="188" y="86" />
          <path d="M0 150Q160 112 320 150V180H0Z" fill="#d4dccb" />
        </>
      );
    case "coral-bay":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#ffe1d6"],
                [1, "#ff9e8a"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="90" cy="72" fill="#fff1e6" r="26" />
          <path
            d="M0 122Q40 110 80 122T160 122 240 122 320 122V180H0Z"
            fill="#2bb3b1"
          />
          <path
            d="M0 146Q40 134 80 146T160 146 240 146 320 146V180H0Z"
            fill="#138d90"
          />
        </>
      );
    case "lilac-dusk":
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#c4b5fd"],
                [0.65, "#7c3aed"],
                [1, "#4c1d95"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="246" cy="54" fill="#fef9c3" opacity=".92" r="18" />
          <circle cx="254" cy="48" fill="#b39cf9" r="15" />
          <path
            d="M0 140Q90 112 180 138T320 128V180H0Z"
            fill="#5b21b6"
            opacity=".85"
          />
          <path d="M0 160Q120 142 230 162T320 158V180H0Z" fill="#2e1065" />
        </>
      );
  }
}

export function ClassCoverArt({
  className,
  theme,
}: {
  className?: string;
  theme: ClassCoverTheme;
}) {
  const id = `cover${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span
      aria-hidden="true"
      className={["class-cover-art", className].filter(Boolean).join(" ")}
      data-cover={theme}
    >
      <svg
        focusable="false"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 320 180"
      >
        {coverScene(theme, id)}
      </svg>
    </span>
  );
}

/** Native radio group of cover swatches (arrow keys move the choice). */
export function ClassCoverPicker({
  legend,
  name,
  onChange,
  themes = classCoverThemes,
  value,
}: {
  legend: string;
  name: string;
  onChange: (theme: ClassCoverTheme) => void;
  themes?: readonly ClassCoverTheme[];
  /** `null` while the class still uses its automatic cover. */
  value: ClassCoverTheme | null;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="class-cover-picker">
      <legend>{legend}</legend>
      <div className="class-cover-picker__options">
        {themes.map((theme) => (
          <label className="class-cover-picker__option" key={theme}>
            <input
              checked={value === theme}
              className="visually-hidden"
              name={name}
              onChange={() => onChange(theme)}
              type="radio"
              value={theme}
            />
            <ClassCoverArt theme={theme} />
            <span className="class-cover-picker__check" aria-hidden="true">
              <Check />
            </span>
            <span className="visually-hidden">
              {t(`classroom.cover.${theme}`)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
