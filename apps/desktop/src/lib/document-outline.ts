/**
 * Document outline for the writing surface.
 *
 * A Markdown document's headings, the text each one owns, and a size readout for
 * the whole file. This is the data the Files preview's outline rail renders: it
 * exists so a long article can be navigated, measured and section-copied
 * without reading the whole thing, and so the agent's own output can be checked
 * for an article-shaped structure instead of a wall of prose.
 *
 * Deliberately not a Markdown parser: ATX headings only, fenced code and the
 * frontmatter block excluded, everything else treated as body text.
 */

export type DocumentHeading = {
  /** Stable id: `${level}-${line}`; unique because a line holds one heading. */
  id: string;
  level: number;
  text: string;
  /** 1-based line number of the heading itself. */
  line: number;
  /** Body text this heading owns, excluding nested headings. */
  body: string;
  words: number;
};

export type DocumentStats = {
  words: number;
  characters: number;
  headings: number;
  /** Whole minutes at ~250 words per minute; 0 for an empty document. */
  readingMinutes: number;
};

export type DocumentOutline = {
  headings: DocumentHeading[];
  stats: DocumentStats;
};

const FRONTMATTER = /^---\r?\n([^]*?)\r?\n---\r?\n?/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Words in a body of text: Latin runs plus one per CJK character. */
export function countWords(text: string): number {
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  return latin + cjk;
}

/**
 * Split a Markdown document into its ATX headings and the text each owns.
 * Fenced code and a leading frontmatter block are content, never headings:
 * a `#` inside a shell snippet must not become an outline row.
 */
export function parseDocumentOutline(markdown: string): DocumentOutline {
  // Blank out the frontmatter rather than deleting it, so a heading's reported
  // line still matches the line the editor shows.
  const source = markdown.replace(FRONTMATTER, (block) => "\n".repeat(block.split("\n").length - 1));
  const lines = source.split(/\r?\n/);
  const headings: { level: number; text: string; line: number; bodyLines: string[] }[] = [];
  let fence: string | null = null;
  let current: (typeof headings)[number] | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0]) && marker.length >= fence.length) fence = null;
      // The fence line itself is body text of the section it sits in.
      current?.bodyLines.push(line);
      return;
    }
    const heading = fence === null ? line.match(ATX_HEADING) : null;
    if (heading) {
      current = {
        level: heading[1].length,
        text: heading[2].trim(),
        line: index + 1,
        bodyLines: [],
      };
      headings.push(current);
      return;
    }
    current?.bodyLines.push(line);
  });

  const parsed = headings.map((heading) => {
    const body = heading.bodyLines.join("\n").trim();
    return {
      id: `${heading.level}-${heading.line}`,
      level: heading.level,
      text: heading.text,
      line: heading.line,
      body,
      words: countWords(body),
    };
  });

  // Measurement ignores the frontmatter block entirely; the blanked copy above
  // exists only to keep heading line numbers aligned.
  const measurable = markdown.replace(FRONTMATTER, "");
  const words = countWords(measurable);
  return {
    headings: parsed,
    stats: {
      words,
      characters: measurable.length,
      headings: parsed.length,
      readingMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / 250)),
    },
  };
}

/**
 * The section a heading owns, as Markdown — the heading line plus its body.
 * Used by the outline's copy action so a passage can move into the composer or
 * another document without selecting it by hand.
 */
export function sectionText(markdown: string, heading: DocumentHeading): string {
  const body = heading.body.trim();
  const title = `${"#".repeat(heading.level)} ${heading.text}`;
  return body ? `${title}\n\n${body}` : title;
}
