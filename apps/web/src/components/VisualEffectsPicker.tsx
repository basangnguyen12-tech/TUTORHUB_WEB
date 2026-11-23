import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tutorhub/ui";
import {
  Ban,
  Check,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useI18n } from "../app/i18n";
import {
  CUSTOM_BACKGROUND_LIMIT,
  CUSTOM_BACKGROUND_TYPES,
  CustomBackgroundError,
  DEFAULT_VISUAL_EFFECTS,
  VISUAL_BACKGROUND_PRESET_IDS,
  VISUAL_LIGHTING_BRIGHTNESS,
  VISUAL_LIGHTING_TONES,
  hasActiveLighting,
  visualBackgroundPresetUrl,
  type ClassroomVisualEffectsState,
  type CustomBackgroundErrorCode,
  type CustomBackgroundLibrary,
  type VisualBackgroundState,
  type VisualLightingState,
} from "../app/visualEffects";
import "./VisualEffectsPicker.css";

export interface VisualEffectsPickerProps {
  /** `modal`: Pre-Join studio (light). `drawer`: classroom side panel (dark). */
  surface: "modal" | "drawer";
  value: ClassroomVisualEffectsState;
  onChange: (next: ClassroomVisualEffectsState) => void;
  library: CustomBackgroundLibrary;
  disabled?: boolean;
}

/**
 * Shared Backgrounds | Lighting picker (ADR-0041). Picking an option only
 * changes the choice; it never opens the camera.
 */
export function VisualEffectsPicker({
  surface,
  value,
  onChange,
  library,
  disabled = false,
}: VisualEffectsPickerProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState("backgrounds");

  return (
    <Tabs
      className={`vfx-picker vfx-picker--${surface}`}
      onValueChange={setTab}
      value={tab}
    >
      <TabsList aria-label={t("media.fx.tabsLabel")} className="vfx-tabs">
        <TabsTrigger className="vfx-tabs__trigger" value="backgrounds">
          {t("media.fx.tabBackgrounds")}
        </TabsTrigger>
        <TabsTrigger className="vfx-tabs__trigger" value="lighting">
          {t("media.fx.tabLighting")}
        </TabsTrigger>
      </TabsList>
      <TabsContent className="vfx-panel" value="backgrounds">
        <BackgroundsPanel
          disabled={disabled}
          library={library}
          onChange={(background) => onChange({ ...value, background })}
          value={value.background}
        />
      </TabsContent>
      <TabsContent className="vfx-panel" value="lighting">
        <LightingPanel
          disabled={disabled}
          onChange={(lighting) => onChange({ ...value, lighting })}
          value={value.lighting}
        />
      </TabsContent>
    </Tabs>
  );
}

function BackgroundsPanel({
  disabled,
  library,
  onChange,
  value,
}: {
  disabled: boolean;
  library: CustomBackgroundLibrary;
  onChange: (background: VisualBackgroundState) => void;
  value: VisualBackgroundState;
}) {
  const { t } = useI18n();
  const blurHeading = useId();
  const spacesHeading = useId();
  const privacyId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] =
    useState<CustomBackgroundErrorCode | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const customEnabled =
    library.status !== "disabled" && library.status !== "unavailable";
  const full = library.items.length >= CUSTOM_BACKGROUND_LIMIT;

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Allow choosing the same file again after an error.
    input.value = "";
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    setAnnouncement("");
    try {
      const item = await library.add(file);
      onChange({ kind: "custom", imageId: item.id });
      setAnnouncement(t("media.fx.customAdded"));
    } catch (error) {
      setUploadError(
        error instanceof CustomBackgroundError
          ? error.code
          : "storage_unavailable",
      );
    } finally {
      setUploading(false);
    }
  };

  const removeCustom = async (id: string) => {
    setUploadError(null);
    try {
      await library.remove(id);
      if (value.kind === "custom" && value.imageId === id) {
        onChange({ kind: "none" });
      }
      setAnnouncement(t("media.fx.customRemoved"));
      uploadButton.current?.focus();
    } catch {
      setUploadError("storage_unavailable");
    }
  };

  return (
    <>
      <section aria-labelledby={blurHeading} className="vfx-group">
        <h3 className="vfx-group__title" id={blurHeading}>
          {t("media.fx.groupBlur")}
        </h3>
        <div className="vfx-grid vfx-grid--compact">
          <OptionTile
            disabled={disabled}
            icon={<Ban />}
            label={t("media.fx.none")}
            onSelect={() => onChange({ kind: "none" })}
            selected={value.kind === "none"}
          />
          <OptionTile
            disabled={disabled}
            icon={<span aria-hidden="true" className="vfx-blur-glyph" />}
            label={t("media.fx.blurLight")}
            onSelect={() => onChange({ kind: "blur", strength: "light" })}
            selected={value.kind === "blur" && value.strength === "light"}
          />
          <OptionTile
            disabled={disabled}
            icon={
              <span
                aria-hidden="true"
                className="vfx-blur-glyph vfx-blur-glyph--strong"
              />
            }
            label={t("media.fx.blurStrong")}
            onSelect={() => onChange({ kind: "blur", strength: "strong" })}
            selected={value.kind === "blur" && value.strength === "strong"}
          />
          {customEnabled && (
            <button
              aria-busy={uploading || undefined}
              aria-describedby={privacyId}
              aria-disabled={disabled || full || uploading || undefined}
              className="vfx-tile vfx-tile--upload"
              onClick={() => {
                if (!disabled && !full && !uploading)
                  fileInput.current?.click();
              }}
              ref={uploadButton}
              type="button"
            >
              <span aria-hidden="true" className="vfx-tile__icon">
                {uploading ? (
                  <LoaderCircle className="vfx-spin" />
                ) : (
                  <ImagePlus />
                )}
              </span>
              <span className="vfx-tile__label">
                {uploading ? t("media.fx.uploading") : t("media.fx.upload")}
              </span>
            </button>
          )}
          {library.items.map((item, index) => {
            const selected =
              value.kind === "custom" && value.imageId === item.id;
            const name = t("media.fx.customImage", { index: index + 1 });
            return (
              <div className="vfx-tile-wrap" key={item.id}>
                <button
                  aria-pressed={selected}
                  className="vfx-tile vfx-tile--image"
                  disabled={disabled}
                  onClick={() => onChange({ kind: "custom", imageId: item.id })}
                  type="button"
                >
                  <img
                    alt=""
                    className="vfx-tile__image"
                    decoding="async"
                    src={item.url}
                  />
                  <span className="visually-hidden">{name}</span>
                  {selected && <SelectedMark />}
                </button>
                <button
                  aria-label={t("media.fx.removeCustom", { index: index + 1 })}
                  className="vfx-tile__remove"
                  disabled={disabled}
                  onClick={() => void removeCustom(item.id)}
                  title={t("media.fx.removeCustom", { index: index + 1 })}
                  type="button"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {customEnabled ? (
          <>
            <input
              accept={CUSTOM_BACKGROUND_TYPES.join(",")}
              aria-hidden="true"
              aria-label={t("media.fx.upload")}
              className="visually-hidden"
              data-testid="vfx-upload-input"
              disabled={disabled || full}
              onChange={(event) => void pick(event)}
              ref={fileInput}
              tabIndex={-1}
              type="file"
            />
            <p className="vfx-note" id={privacyId}>
              {t("media.fx.customPrivacy", { count: CUSTOM_BACKGROUND_LIMIT })}
            </p>
          </>
        ) : library.status === "unavailable" ? (
          <p className="vfx-note">{t("media.fx.customUnavailable")}</p>
        ) : null}
        {uploadError && (
          <p className="vfx-error" role="alert">
            {t(`media.fx.error.${uploadError}`, {
              count: CUSTOM_BACKGROUND_LIMIT,
            })}
          </p>
        )}
        <p aria-live="polite" className="visually-hidden" role="status">
          {announcement}
        </p>
      </section>

      <section aria-labelledby={spacesHeading} className="vfx-group">
        <h3 className="vfx-group__title" id={spacesHeading}>
          {t("media.fx.groupSpaces")}
        </h3>
        <div className="vfx-grid">
          {VISUAL_BACKGROUND_PRESET_IDS.map((presetId) => {
            const selected =
              value.kind === "preset" && value.presetId === presetId;
            return (
              <button
                aria-pressed={selected}
                className="vfx-tile vfx-tile--image vfx-tile--preset"
                data-preset={presetId}
                disabled={disabled}
                key={presetId}
                onClick={() => onChange({ kind: "preset", presetId })}
                type="button"
              >
                <img
                  alt=""
                  className="vfx-tile__image"
                  decoding="async"
                  loading="lazy"
                  src={visualBackgroundPresetUrl(presetId)}
                />
                <span className="vfx-tile__caption">
                  {t(`media.fx.preset.${presetId}`)}
                </span>
                {selected && <SelectedMark />}
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function LightingPanel({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (lighting: VisualLightingState) => void;
  value: VisualLightingState;
}) {
  const { t } = useI18n();
  const name = useId();
  const active = hasActiveLighting({
    background: { kind: "none" },
    lighting: value,
  });

  return (
    <div className="vfx-lighting">
      <p className="vfx-note vfx-note--lead">
        <Sparkles aria-hidden="true" />
        {t("media.fx.lightingHint")}
      </p>
      <fieldset className="vfx-fieldset" disabled={disabled}>
        <legend className="vfx-group__title">
          {t("media.fx.brightnessLegend")}
        </legend>
        <div className="vfx-choices">
          {VISUAL_LIGHTING_BRIGHTNESS.map((brightness) => (
            <ChoiceRadio
              checked={value.brightness === brightness}
              key={brightness}
              label={t(`media.fx.brightness.${brightness}`)}
              name={`${name}-brightness`}
              onSelect={() => onChange({ ...value, brightness })}
              swatch={`vfx-swatch--${brightness}`}
              value={brightness}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="vfx-fieldset" disabled={disabled}>
        <legend className="vfx-group__title">{t("media.fx.toneLegend")}</legend>
        <div className="vfx-choices">
          {VISUAL_LIGHTING_TONES.map((tone) => (
            <ChoiceRadio
              checked={value.tone === tone}
              key={tone}
              label={t(`media.fx.tone.${tone}`)}
              name={`${name}-tone`}
              onSelect={() => onChange({ ...value, tone })}
              swatch={`vfx-swatch--${tone}`}
              value={tone}
            />
          ))}
        </div>
      </fieldset>
      {active && (
        <button
          className="vfx-reset"
          disabled={disabled}
          onClick={() => onChange({ ...DEFAULT_VISUAL_EFFECTS.lighting })}
          type="button"
        >
          <RotateCcw aria-hidden="true" />
          {t("media.fx.resetLighting")}
        </button>
      )}
    </div>
  );
}

function OptionTile({
  disabled,
  icon,
  label,
  onSelect,
  selected,
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className="vfx-tile vfx-tile--option"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span aria-hidden="true" className="vfx-tile__icon">
        {icon}
      </span>
      <span className="vfx-tile__label">{label}</span>
      {selected && <SelectedMark />}
    </button>
  );
}

function ChoiceRadio({
  checked,
  label,
  name,
  onSelect,
  swatch,
  value,
}: {
  checked: boolean;
  label: string;
  name: string;
  onSelect: () => void;
  swatch: string;
  value: string;
}) {
  return (
    <label className="vfx-choice">
      <input
        checked={checked}
        className="vfx-choice__input"
        name={name}
        onChange={onSelect}
        type="radio"
        value={value}
      />
      <span aria-hidden="true" className={`vfx-swatch ${swatch}`} />
      <span className="vfx-choice__label">{label}</span>
      <Check aria-hidden="true" className="vfx-choice__check" />
    </label>
  );
}

function SelectedMark() {
  return (
    <span aria-hidden="true" className="vfx-tile__check">
      <Check />
    </span>
  );
}
