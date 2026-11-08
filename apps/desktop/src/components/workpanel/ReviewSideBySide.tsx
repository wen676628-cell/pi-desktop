import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

type LoadState = { loading: boolean; left: string | null; right: string | null };

/**
 * Two recorded versions of one file, read from the host's snapshot store.
 * This never consults the mutable workspace, so an old preview cannot be
 * mistaken for the current file.
 */
export function ReviewSideBySide({
  sessionId,
  leftSnapshotId,
  rightSnapshotId,
  leftLabel,
  rightLabel,
}: {
  sessionId: string;
  leftSnapshotId: string;
  rightSnapshotId: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ loading: true, left: null, right: null });

  useEffect(() => {
    let active = true;
    setState({ loading: true, left: null, right: null });
    Promise.all([
      api.workspaceReviewSnapshotContent({ sessionId, snapshotId: leftSnapshotId }),
      api.workspaceReviewSnapshotContent({ sessionId, snapshotId: rightSnapshotId }),
    ])
      .then(([left, right]) => {
        if (active) setState({ loading: false, left: left.content, right: right.content });
      })
      .catch(() => {
        if (active) setState({ loading: false, left: null, right: null });
      });
    return () => {
      active = false;
    };
  }, [sessionId, leftSnapshotId, rightSnapshotId]);

  if (state.loading) {
    return <div className="review-side-by-side review-side-by-side-state">{t("panel.review.compareLoading")}</div>;
  }
  if (state.left === null || state.right === null) {
    return <div className="review-side-by-side review-side-by-side-state">{t("panel.review.compareUnavailable")}</div>;
  }
  return (
    <div className="review-side-by-side">
      <div className="review-side-by-side-col">
        <div className="review-side-by-side-head">{leftLabel}</div>
        <pre>{state.left}</pre>
      </div>
      <div className="review-side-by-side-col">
        <div className="review-side-by-side-head">{rightLabel}</div>
        <pre>{state.right}</pre>
      </div>
    </div>
  );
}
