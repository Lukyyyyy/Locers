import type { ServiceStatus } from "../api/types";
import { statusLabel, useI18n } from "./i18n";

export function StatusPill({ status }: { status: ServiceStatus }) {
  const { language } = useI18n();
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {statusLabel(status, language)}
    </span>
  );
}
