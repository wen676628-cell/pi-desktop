import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

/**
 * Warns when provider secrets are encrypted with the local fallback key
 * instead of OS secure storage. The fallback key lives beside the ciphertext,
 * so copying the whole profile also copies the material that decrypts it.
 */
export function SecretsBackendWarning() {
  const { t } = useTranslation();
  const [backend, setBackend] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getSecretsBackend()
      .then((value) => {
        if (alive) setBackend(value);
      })
      .catch(() => {
        // A missing host is already reported by the surrounding page; the
        // warning is only meaningful when the host answered.
      });
    return () => {
      alive = false;
    };
  }, []);
  if (backend !== "file_fallback") return null;
  return (
    <div className="settings-secret-fallback" role="status">
      {t("settings.secretFallback")}
    </div>
  );
}
