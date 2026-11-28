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
 *
 * MSG-AVATAR-SEARCH-CLASSIN-01: saturated, painterly scenes whose subject sits
 * in the centre square (x 70-250 of the 320x180 view box), which is all a
 * 36-64px conversation avatar shows with `xMidYMid slice`. No theme keeps a
 * pale or white top any more, so small avatars stay vivid on a white list.
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
  [18, 22, 1.2],
  [44, 58, 0.9],
  [74, 16, 1.3],
  [104, 40, 0.8],
  [128, 12, 1],
  [182, 22, 0.9],
  [196, 64, 0.8],
  [262, 28, 1.2],
  [292, 54, 0.9],
  [308, 16, 1.1],
  [142, 84, 0.7],
  [60, 96, 0.8],
] as const;

/** Two-tier pine silhouettes standing on `base`. */
function pines(
  xs: readonly number[],
  base: number,
  height: number,
  half: number,
  fill: string,
) {
  const shoulder = base - height * 0.5;
  return xs.map((x) => (
    <path
      d={`M${x} ${base - height}L${x - half * 0.6} ${shoulder}H${x - half * 0.3}L${x - half} ${base}H${x + half}L${x + half * 0.3} ${shoulder}H${x + half * 0.6}Z`}
      fill={fill}
      key={x}
    />
  ));
}

function coverScene(theme: ClassCoverTheme, id: string): ReactNode {
  const sky = `${id}s`;
  const accent = `${id}a`;
  const water = `${id}w`;
  switch (theme) {
    case "starry-night":
      // Swirling night sky over a sleeping village.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#0b1a4a"],
                [0.55, "#1d3c8f"],
                [1, "#2f5fb3"],
              ]}
              x2={0.4}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <g fill="none" strokeLinecap="round">
            <path
              d="M30 96C70 52 118 44 150 66S214 98 238 70 286 34 330 54"
              stroke="#8fc1ff"
              strokeOpacity=".55"
              strokeWidth="7"
            />
            <path
              d="M64 58C92 30 140 24 170 42"
              stroke="#c7ddff"
              strokeOpacity=".45"
              strokeWidth="4"
            />
            <path
              d="M124 80a20 20 0 1 0 40-4c-2 11-11 17-20 15s-13-9-9-16c3-6 9-7 14-4"
              stroke="#e0ecff"
              strokeOpacity=".75"
              strokeWidth="3.4"
            />
          </g>
          <circle cx="222" cy="42" fill="#fde68a" opacity=".28" r="26" />
          <circle cx="222" cy="42" fill="#fde047" r="15" />
          {stars.map(([cx, cy, r]) => (
            <g key={cx}>
              <circle cx={cx} cy={cy} fill="#fef3c7" opacity=".3" r={r * 3} />
              <circle cx={cx} cy={cy} fill="#fff7cc" r={r} />
            </g>
          ))}
          <path d="M0 180V138Q70 118 150 136T320 128V180Z" fill="#0f2557" />
          <path d="M0 180V156Q96 140 200 156T320 150V180Z" fill="#081633" />
          <path
            d="M98 180C92 150 96 112 104 84c8 30 12 66 6 96Z"
            fill="#06101f"
          />
          <g fill="#fcd34d">
            <rect height="4" rx="1" width="4" x="168" y="150" />
            <rect height="4" rx="1" width="4" x="186" y="154" />
            <rect height="4" rx="1" width="4" x="230" y="148" />
          </g>
        </>
      );
    case "pastel-dawn":
      // Saturated pastel sunrise over a calm sea.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#4f6df5"],
                [0.42, "#9d7bf2"],
                [0.72, "#f39acb"],
                [1, "#fdc89b"],
              ]}
            />
            <Gradient
              id={water}
              stops={[
                [0, "#8a8ff0"],
                [1, "#4b4fc9"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="160" cy="118" fill="#fff1c2" opacity=".35" r="50" />
          <circle cx="160" cy="118" fill="#fff4d0" r="28" />
          <g fill="#ffffff" opacity=".42">
            <ellipse cx="92" cy="54" rx="40" ry="9" />
            <ellipse cx="236" cy="38" rx="46" ry="8" />
            <ellipse cx="200" cy="74" rx="30" ry="6" />
          </g>
          <rect fill={`url(#${water})`} height="60" width="320" y="120" />
          <g stroke="#ffe3a3" strokeLinecap="round" strokeWidth="3">
            <path d="M134 132H186" />
            <path d="M144 144H176" strokeOpacity=".8" />
            <path d="M150 156H170" strokeOpacity=".6" />
          </g>
          <path
            d="M0 168Q80 158 160 168T320 166V180H0Z"
            fill="#3b3fb0"
            opacity=".7"
          />
        </>
      );
    case "alpine-lake":
      // Snowy peaks over an emerald lake.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#1f5fd6"],
                [0.6, "#5aa2f0"],
                [1, "#b6dcfb"],
              ]}
            />
            <Gradient
              id={water}
              stops={[
                [0, "#14a89a"],
                [1, "#0b5e63"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <path
            d="M0 118L52 70 92 98 160 26 226 92 268 58 320 104V130H0Z"
            fill="#3c5f99"
          />
          <path
            d="M160 26L140 52 152 48 162 58 172 46 184 52ZM268 58 256 72 268 68 280 76ZM52 70 40 82 52 79 62 86Z"
            fill="#f8fbff"
          />
          <path
            d="M0 128L44 100 86 118 132 88 186 122 238 96 320 124V140H0Z"
            fill="#1d3f6e"
          />
          {pines(
            [8, 26, 44, 62, 80, 220, 240, 258, 278, 300, 316],
            136,
            26,
            7,
            "#0f3b2c",
          )}
          <rect fill={`url(#${water})`} height="48" width="320" y="132" />
          <path d="M146 132L160 160 174 132Z" fill="#f8fbff" opacity=".22" />
          <g
            stroke="#e6fffb"
            strokeLinecap="round"
            strokeOpacity=".4"
            strokeWidth="2"
          >
            <path d="M36 150H104" />
            <path d="M188 160H272" />
            <path d="M104 170H150" />
          </g>
        </>
      );
    case "golden-horizon":
      // Sunset over the sea.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#e8456b"],
                [0.45, "#f97316"],
                [0.8, "#fbbf24"],
                [1, "#fde68a"],
              ]}
            />
            <Gradient
              id={water}
              stops={[
                [0, "#c2410c"],
                [1, "#5a1a08"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="160" cy="114" fill="#fff3c4" opacity=".4" r="52" />
          <circle cx="160" cy="114" fill="#fff6d8" r="27" />
          <path
            d="M0 120Q30 104 64 112T120 120H0Z"
            fill="#8a2a10"
            opacity=".85"
          />
          <rect fill={`url(#${water})`} height="60" width="320" y="120" />
          <g stroke="#fde68a" strokeLinecap="round">
            <path d="M128 130H192" strokeWidth="4" />
            <path d="M138 142H182" strokeOpacity=".85" strokeWidth="3.4" />
            <path d="M146 154H174" strokeOpacity=".7" strokeWidth="3" />
            <path d="M152 166H168" strokeOpacity=".55" strokeWidth="2.6" />
          </g>
          <g fill="none" stroke="#7c2d12" strokeLinecap="round" strokeWidth="2">
            <path d="M206 54q6-6 12 0q6-6 12 0" />
            <path d="M234 70q4-4 8 0q4-4 8 0" />
          </g>
        </>
      );
    case "misty-pine":
      // Pine ridges in a teal morning mist.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#17645d"],
                [0.55, "#4fae98"],
                [1, "#bfe8d8"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="214" cy="52" fill="#f0fdf4" opacity=".75" r="18" />
          {pines(
            [10, 40, 72, 104, 136, 168, 200, 232, 264, 296, 320],
            118,
            54,
            15,
            "#3f907c",
          )}
          <rect fill="#e6fbf2" height="26" opacity=".28" width="320" y="100" />
          {pines(
            [24, 64, 104, 144, 184, 224, 264, 304],
            150,
            70,
            19,
            "#1d6450",
          )}
          {pines([-6, 44, 96, 150, 206, 258, 312], 182, 82, 24, "#0b3a2d")}
        </>
      );
    case "minimal-studio":
      // Minimal Bauhaus composition on a warm terracotta wall.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#f2a65a"],
                [1, "#e26d4c"],
              ]}
              x2={1}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <circle cx="126" cy="76" fill="#21475a" r="46" />
          <path d="M168 150a44 44 0 0 1 88 0Z" fill="#f4d06f" />
          <rect fill="#2a9d8f" height="78" width="54" x="146" y="102" />
          <circle cx="232" cy="52" fill="#fdf6e3" r="9" />
          <path
            d="M60 140H290"
            stroke="#fdf6e3"
            strokeLinecap="round"
            strokeWidth="3"
          />
          <rect fill="#b8432c" height="30" width="320" y="150" />
        </>
      );
    case "coral-bay":
      // Coral oil-paint strokes over a turquoise bay.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#ff5f6d"],
                [0.55, "#ff8f4f"],
                [1, "#ffc56b"],
              ]}
              x2={1}
              y2={1}
            />
            <Gradient
              id={water}
              stops={[
                [0, "#22b8b0"],
                [1, "#0f7a7d"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          <g fill="none" strokeLinecap="round">
            <path
              d="M-10 70C60 30 120 96 190 52S300 20 340 40"
              stroke="#ff3d5a"
              strokeOpacity=".7"
              strokeWidth="22"
            />
            <path
              d="M-10 110C70 80 130 130 200 92S290 70 340 86"
              stroke="#ffd36e"
              strokeOpacity=".75"
              strokeWidth="18"
            />
            <path
              d="M40 36C100 16 170 40 230 18"
              stroke="#fff1e0"
              strokeOpacity=".55"
              strokeWidth="8"
            />
          </g>
          <path
            d="M0 128Q40 116 80 128T160 128 240 128 320 128V180H0Z"
            fill={`url(#${water})`}
          />
          <path
            d="M0 150Q40 138 80 150T160 150 240 150 320 150V180H0Z"
            fill="#0b5f63"
          />
        </>
      );
    case "lilac-dusk":
      // Violet dusk with a rising moon over the hills.
      return (
        <>
          <defs>
            <Gradient
              id={sky}
              stops={[
                [0, "#2b1d7a"],
                [0.5, "#7a3ee6"],
                [1, "#e9a3f5"],
              ]}
            />
            <Gradient
              id={accent}
              stops={[
                [0, "#6d28d9"],
                [1, "#3b0f7a"],
              ]}
            />
          </defs>
          <rect fill={`url(#${sky})`} height="180" width="320" />
          {stars.slice(0, 8).map(([cx, cy, r]) => (
            <circle cx={cx} cy={cy} fill="#fdf4ff" key={cx} r={r} />
          ))}
          <circle cx="204" cy="60" fill="#fef9c3" opacity=".25" r="30" />
          <circle cx="204" cy="60" fill="#fef9c3" r="17" />
          <path
            d="M0 132Q90 100 180 128T320 116V180H0Z"
            fill={`url(#${accent})`}
          />
          <path d="M0 156Q120 136 230 158T320 154V180H0Z" fill="#240a4f" />
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
