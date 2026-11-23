import { useState } from "react";
import type { MediaDiagnosticExport } from "@tutorhub/api-client";
import { Button } from "@tutorhub/ui";
import { Download, RefreshCw } from "lucide-react";
import { loadMediaDiagnostics } from "../app/mediaDiagnostics";
import { useI18n } from "../app/i18n";

/**
 * Redacted 24-hour media diagnostics for org admins. Nothing is fetched until
 * the explicit load action. `embedded` drops the panel's own heading and
 * privacy note for hosts (the Pre-Join dialog) that already render them as the
 * dialog title and description.
 */
export function MediaDiagnosticsPanel({
  tenantID,
  variant = "standalone",
}: {
  tenantID: string;
  variant?: "standalone" | "embedded";
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [diagnostics, setDiagnostics] = useState<MediaDiagnosticExport | null>(
    null,
  );

  const load = async () => {
    setStatus("loading");
    try {
      setDiagnostics(await loadMediaDiagnostics(tenantID));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  const download = () => {
    if (!diagnostics) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnostics, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tutorhub-media-diagnostics.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const embedded = variant === "embedded";
  const body = (
    <>
      <div className="media-p410-diagnostics__actions">
        <Button
          disabled={status === "loading"}
          leadingIcon={<RefreshCw />}
          onClick={() => void load()}
          size="md"
          variant={diagnostics ? "secondary" : "primary"}
        >
          {status === "loading"
            ? t("media.p410.loading")
            : t("media.p410.load")}
        </Button>
      </div>
      {status === "error" && (
        <p className="media-p410-diagnostics__error" role="alert">
          {t("media.p410.error")}
        </p>
      )}
      {diagnostics && (
        <div aria-live="polite" className="media-p410-diagnostics__result">
          <dl className="media-p410-diagnostics__metrics">
            <div>
              <dt>{t("media.p410.joinSuccess")}</dt>
              <dd>
                {Math.round(diagnostics.metrics.join_success_rate * 100)}%
              </dd>
            </div>
            <div>
              <dt>{t("media.p410.p95")}</dt>
              <dd>{diagnostics.metrics.p95_time_to_media_ms} ms</dd>
            </div>
            <div>
              <dt>{t("media.p410.reconnect")}</dt>
              <dd>
                {diagnostics.metrics.reconnect_succeeded}/
                {diagnostics.metrics.reconnect_failed}
              </dd>
            </div>
          </dl>
          <Button
            leadingIcon={<Download />}
            onClick={download}
            size="md"
            variant="quiet"
          >
            {t("media.p410.download")}
          </Button>
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="media-p410-diagnostics media-p410-diagnostics--embedded">
        {body}
      </div>
    );
  }

  return (
    <section
      className="media-p410-diagnostics"
      aria-labelledby="media-p410-title"
    >
      <h2 id="media-p410-title">{t("media.p410.title")}</h2>
      <p>{t("media.p410.privacy")}</p>
      {body}
    </section>
  );
}
