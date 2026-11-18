/**
 * The outline rail of the writing surface.
 *
 * Files → a Markdown file → Outline shows the document's headings with the size
 * of each section and a whole-document readout. Clicking a row copies that
 * section, which is how a passage moves into the composer without selecting it
 * by hand.
 *
 * Read-only on purpose: the file is the source of truth the agent also writes,
 * and a second editor over the same path would be a second writer. The rail
 * exists to navigate and measure, not to become an editor.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import {
  parseDocumentOutline,
  sectionText,
  type DocumentHeading,
} from "../../lib/document-outline";

export function DocumentOutline({
  markdown,
  onCopied,
}: {
  markdown: string;
  /** Called after a section lands on the clipboard, so the page can toast. */
  onCopied?: (heading: DocumentHeading) => void;
}) {
  const { t } = useTranslation();
  const outline = useMemo(() => parseDocumentOutline(markdown), [markdown]);
  const [copied, setCopied] = useState<string | null>(null);
  // Two levels of indentation are enough to read an article's structure; deeper
  // headings stay aligned with their parent instead of walking off the rail.
  const indentFor = (level: number) => Math.min(level - 1, 2) * 10;

  if (outline.headings.length === 0) {
    return (
      <div className="document-outline" data-empty="true">
        <p className="document-outline-empty">{t("panel.files.outlineEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="document-outline">
      <div className="document-outline-stats">
        {t("panel.files.outlineStats", {
          words: outline.stats.words,
          minutes: outline.stats.readingMinutes,
        })}
      </div>
      <ul className="document-outline-list">
        {outline.headings.map((heading) => (
          <li
            key={heading.id}
            className="document-outline-row"
            style={{ paddingInlineStart: indentFor(heading.level) }}
          >
            <span className="document-outline-title" title={heading.text}>
              {heading.text}
            </span>
            <span className="document-outline-words">
              {t("panel.files.outlineSectionWords", { count: heading.words })}
            </span>
            <TooltipButton
              type="button"
              className="icon-btn icon-btn-square"
              tooltip={t("panel.files.outlineCopySection")}
              ariaLabel={t("panel.files.outlineCopySection")}
              onClick={() => {
                void navigator.clipboard
                  .writeText(sectionText(markdown, heading))
                  .then(() => {
                    setCopied(heading.id);
                    onCopied?.(heading);
                  })
                  .catch(() => setCopied(null));
              }}
            >
              {copied === heading.id ? "✓" : t("panel.files.outlineCopy")}
            </TooltipButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
