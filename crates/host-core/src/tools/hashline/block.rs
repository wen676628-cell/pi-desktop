//! Syntax-light block resolution for `N*` / `>N*` locators (ADR 0087 phase 3).
//!
//! The contract only needs a deterministic span, not a full parse tree. Three
//! rules cover the shapes edits actually anchor on:
//!
//! 1. **Markdown heading span** — a `#` heading opens a section that runs to
//!    the next heading of the same or a higher level; deeper headings stay
//!    inside it.
//! 2. **Brace span** — the anchor opens `{` and the span ends on the line
//!    where the matching brace depth returns to zero. Strings and comments
//!    are ignored so a brace inside a literal cannot move the end.
//! 3. **Indentation span** — the anchor does not open a brace but the next
//!    non-blank line is indented deeper; the span extends while lines stay
//!    deeper, which is the block shape of Python, YAML, Ruby, and similar.
//!
//! No rule guesses: a plain statement with no heading, brace, or indented body
//! stays unresolved, and the caller keeps returning `EDIT_BLOCK_UNRESOLVED`
//! instead of silently editing a neighbouring block.

const MAX_BLOCK_SCAN_LINES: usize = 4000;

/// Resolve the block that starts on `anchor` (1-based, inclusive). Returns the
/// inclusive `(start, end)` line range, or `None` when no rule applies.
pub fn resolve_block(lines: &[String], anchor: u32) -> Option<(u32, u32)> {
    let index = anchor.checked_sub(1)? as usize;
    let line = lines.get(index)?;
    if line.trim().is_empty() {
        return None;
    }
    if let Some(end) = heading_span(lines, index) {
        return Some((anchor, end as u32 + 1));
    }
    if let Some(end) = brace_span(lines, index) {
        return Some((anchor, end as u32 + 1));
    }
    if let Some(end) = indent_span(lines, index) {
        return Some((anchor, end as u32 + 1));
    }
    None
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    // CommonMark requires a space (or end of line) after the marker; `#include`
    // and `#region` must stay plain statements.
    match trimmed.chars().nth(hashes) {
        None | Some(' ') => Some(hashes),
        _ => None,
    }
}

fn heading_span(lines: &[String], start: usize) -> Option<usize> {
    let level = heading_level(&lines[start])?;
    let limit = lines.len().min(start + MAX_BLOCK_SCAN_LINES);
    let mut end = start;
    for (offset, line) in lines.iter().enumerate().take(limit).skip(start + 1) {
        if let Some(next) = heading_level(line) {
            if next <= level {
                break;
            }
        }
        end = offset;
    }
    Some(end)
}

/// Track string/comment state while scanning a line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Code,
    LineComment,
    BlockComment,
}

fn brace_span(lines: &[String], start: usize) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut opened = false;
    let mut state = ScanState::Code;
    let limit = lines.len().min(start + MAX_BLOCK_SCAN_LINES);
    for (offset, line) in lines.iter().enumerate().take(limit).skip(start) {
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            match state {
                ScanState::LineComment => break,
                ScanState::BlockComment => {
                    if ch == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        state = ScanState::Code;
                    }
                }
                ScanState::Code => match ch {
                    '"' | '\'' | '`' => {
                        // Consume the literal; an unterminated literal ends at
                        // the line, which keeps the scan conservative.
                        while let Some(inner) = chars.next() {
                            if inner == '\\' {
                                chars.next();
                            } else if inner == ch {
                                break;
                            }
                        }
                    }
                    '/' if chars.peek() == Some(&'/') => {
                        chars.next();
                        state = ScanState::LineComment;
                    }
                    '/' if chars.peek() == Some(&'*') => {
                        chars.next();
                        state = ScanState::BlockComment;
                    }
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' if depth > 0 => {
                        depth -= 1;
                        if opened && depth == 0 {
                            return Some(offset);
                        }
                    }
                    _ => {}
                },
            }
        }
        if state == ScanState::LineComment {
            state = ScanState::Code;
        }
    }
    // An opener that never closes has no defensible span.
    None
}

fn indent_width(line: &str) -> usize {
    let mut width = 0;
    for ch in line.chars() {
        match ch {
            ' ' => width += 1,
            '\t' => width += 4,
            _ => break,
        }
    }
    width
}

fn indent_span(lines: &[String], start: usize) -> Option<usize> {
    let anchor_indent = indent_width(&lines[start]);
    let mut end = start;
    let limit = lines.len().min(start + MAX_BLOCK_SCAN_LINES);
    for (offset, line) in lines.iter().enumerate().take(limit).skip(start + 1) {
        if line.trim().is_empty() {
            // Blank lines inside the block are part of the span; a blank line
            // followed by a same-or-shallower line ends it via that line.
            continue;
        }
        if indent_width(line) > anchor_indent {
            end = offset;
            continue;
        }
        break;
    }
    (end > start).then_some(end)
}

#[cfg(test)]
mod tests {
    use super::resolve_block;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_string).collect()
    }

    #[test]
    fn resolves_a_braced_function() {
        let file = lines("fn outer() {\n    let x = 1;\n}\nfn next() {}\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 3)));
    }

    #[test]
    fn resolves_a_one_line_braced_block() {
        let file = lines("fn next() {}\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 1)));
    }

    #[test]
    fn ignores_braces_inside_strings_and_comments() {
        let file = lines("fn f() {\n    let s = \"}\";\n    // }\n}\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 4)));
    }

    #[test]
    fn resolves_a_nested_brace_span() {
        let file = lines("if x {\n    if y {\n        z();\n    }\n}\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 5)));
    }

    #[test]
    fn resolves_an_indented_python_block() {
        let file =
            lines("def run():\n    a = 1\n    b = 2\n\n    return a\ndef next():\n    pass\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 5)));
    }

    #[test]
    fn stops_at_a_sibling_after_the_block() {
        let file = lines("class A:\n    def m(self):\n        pass\n\nclass B:\n    pass\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 3)));
    }

    #[test]
    fn leaves_a_plain_statement_unresolved() {
        let file = lines("let x = 1;\nlet y = 2;\n");
        assert_eq!(resolve_block(&file, 1), None);
    }

    #[test]
    fn resolves_a_markdown_section_through_deeper_headings() {
        let file = lines("# Title\nintro\n## Sub\nbody\n## Sub 2\nmore\n# Next\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 6)));
    }

    #[test]
    fn stops_at_the_next_heading_of_the_same_level() {
        let file = lines("## Section\nbody\n## Next\nbody\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 2)));
    }

    #[test]
    fn a_heading_followed_by_a_sibling_covers_only_itself() {
        let file = lines("# A\n# B\n");
        assert_eq!(resolve_block(&file, 1), Some((1, 1)));
    }

    #[test]
    fn a_preprocessor_or_region_marker_is_not_a_heading() {
        let file = lines("#include <stdio.h>\nint main(void);\n#endregion\n");
        assert_eq!(resolve_block(&file, 1), None);
    }
}
