/**
 * Centralized LaTeX normalization for chunk / markdown content.
 *
 * Consolidates every delimiter-fix, tag-fix, and bare-environment wrap
 * that was previously scattered across MarkdownRenderer, ChatMarkdown,
 * ChunkDetailDialog, and ChatPage into one idempotent function.
 *
 * Called BEFORE the content is handed to markdown-it + KaTeX.
 */

// ── helpers ────────────────────────────────────────────────────────────

/** Environments whose bare \begin{…}…\end{…} should become display math. */
const BARE_ENVS = [
  "array", "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix",
  "cases", "aligned", "split", "gathered", "equation", "equation\\*",
];
const BARE_ENV_RE = new RegExp(
  `\\\\begin\\{(${BARE_ENVS.join("|")})\\}[\\s\\S]*?\\\\end\\{\\1\\}`,
  "g",
);

/**
 * Temporarily replace $$…$$ blocks with placeholders so later regex
 * transforms cannot accidentally match content already inside display math.
 */
function protectDisplayMath(
  text: string,
): [string, string[]] {
  const store: string[] = [];
  const out = text.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
    store.push(m);
    return `\x00DM${store.length - 1}\x00`;
  });
  return [out, store];
}

function restoreDisplayMath(text: string, store: string[]): string {
  return text.replace(/\x00DM(\d+)\x00/g, (_, i) => store[+i] ?? "");
}

// ── main entry ─────────────────────────────────────────────────────────

export function latexNormalize(raw: string): string {
  let s = raw;

  /* ── Step 0: restore JSON-escaped control characters ───────────── */
  // LLM outputs LaTeX commands like \frac, \tag, \boxed in JSON.
  // After JSON.parse, the backslash-letter pairs become control characters
  // (\f = formfeed 0x0c, \t = tab 0x09, \b = backspace 0x08).
  // Restore them to literal backslash + letter.  Must use charCode(92)
  // because writing "\\f" in TS/JS source may itself be re-escaped.
  const BS = String.fromCharCode(92); // one real backslash
  s = s.replace(/\f/g, () => BS + "f");   // formfeed → \f
  s = s.replace(/\t/g, () => BS + "t");   // tab → \t
  s = s.replace(/\x08/g, () => BS + "b"); // backspace → \b

  /* ── Step 1: delimiter conversions ─────────────────────────────── */
  // \(…\) → $…$  (inline)
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`);
  // \[…\] → $$…$$ (display)
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$\n${inner}\n$$`);

  /* ── Step 2: delimiter cleanup ─────────────────────────────────── */
  // $$$$ → $$
  s = s.replace(/\$\$\$\$/g, "$$");
  // $   $ (3+ spaces → split display math across chunk boundary)
  s = s.replace(/\$\s{3,}\$/g, "$$");
  // $$$…$$$ → $$…$$
  s = s.replace(/\$\$\$([\s\S]*?)\$\$\$/g, (_m, inner) => `$$\n${inner}\n$$`);

  /* ── Step 3: ensure $$ sits on its own line ────────────────────── */
  // text$$… → text\n$$\n…
  s = s.replace(/([^\n$])\$\$/g, "$1\n$$");
  // …$$text → …\n$$\ntext
  s = s.replace(/\$\$([^\n$])/g, "$$\n$1");

  /* ── Step 3.4: $ on its own line → $$ paired display math ─────────── */
  // When MinerU outputs display math with $ on its own line instead of $$,
  // convert BOTH the opening $ and the matching closing $ to $$.
  // This avoids the new $$ getting paired with the wrong delimiter.
  s = s.replace(
    /^\$\n([\s\S]*?)(?<!\$)\$(?!\$)/gm,
    (_m, inner) => `$$\n${inner}$$`,
  );

  /* ── Step 3.5: fix orphaned $$ (one half lives in an adjacent chunk) */
  {
    // Count $$ occurrences to detect orphans
    const ddCount = (s.match(/\$\$/g) || []).length;
    if (ddCount % 2 === 1) {
      // Odd number → one $$ is orphaned.
      // Protect matched pairs first to see which end is orphaned.
      const tempStore: string[] = [];
      const temp = s.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
        tempStore.push(m);
        return `\x00DM${tempStore.length - 1}\x00`;
      });
      // After protection, remaining $$ is the orphan.
      if (temp.includes("$$")) {
        // Find the orphan position
        const orphanIdx = temp.indexOf("$$");
        const textBefore = temp.slice(0, orphanIdx).replace(/\x00DM\d+\x00/g, "");
        const trimmedBefore = textBefore.trim();
        // Determine if orphan is opening or closing:
        // - Empty before → orphan at start → OPENING $$ (close in next chunk)
        // - Before ends with math preamble → OPENING $$ (math follows)
        // - Otherwise → CLOSING $$ (math content precedes it)
        const mathPreamble = /(?:\\left[\s({|]|\(\[=,;:]|\\(?:to|implies|Rightarrow|rightarrow|mapsto|equiv))\s*$/;
        if (!trimmedBefore || mathPreamble.test(trimmedBefore)) {
          s = s + "\n$$";
        } else {
          s = "$$\n" + s;
        }
      }
    }
  }

  /* ── Step 4: protect all $$…$$ from further transforms ─────────── */
  let store: string[];
  [s, store] = protectDisplayMath(s);

  /* ── Step 5: MinerU multi-line $…\tag{N}…$ → display math ─────── */
  // Format: $ on its own line … \tag{N} … $ on its own line
  s = s.replace(
    /^\$\n([\s\S]*?)\\tag\{([^}]+)\}\n\s*\$/gm,
    (_m, body, tag) => `$$\n${body.trim()}\n\\tag{${tag}}\n$$`,
  );
  // Inline $…\tag{N}…$ → $$…\tag{N}…$$
  s = s.replace(
    /\$([^$\n]+?)\\tag\{([^}]+)\}([^$]*?)\$/g,
    (_m, before, tag, after) => `$$\n${before}${after}\\tag{${tag}}\n$$`,
  );

  /* ── Step 6: truncated / orphaned \tag ─────────────────────────── */
  // $$…\tag{N} without closing $$ → add closing
  s = s.replace(
    /(\$\$[^\n]*?\\tag\{[^}]+\})\s*$/gm,
    (_m, body) => `${body.trim()}\n$$`,
  );
  // $\tag{N} without closing $ → wrap
  s = s.replace(
    /(\$(?!\$)[^\n$]*?\\tag\{[^}]+\})\s*$/gm,
    (_m, body) => `$$\n${body.slice(1).trim()}\n$$`,
  );
  // Bare line with \tag{N} and no delimiters
  s = s.replace(
    /^([^\n$]*?)\\tag\{([^}]+)\}([^\n$]*?)$/gm,
    (_m, before, tag, after) => {
      const eq = (before + after).trim();
      return eq ? `$$\n${eq}\n\\tag{${tag}}\n$$` : `$$\n\\tag{${tag}}\n$$`;
    },
  );

  /* ── Step 7: bare LaTeX environments → wrap in $$ ──────────────── */
  s = s.replace(BARE_ENV_RE, (match) => `\n$$\n${match.trim()}\n$$\n`);

  /* ── Step 8: spacing fixes for KaTeX ───────────────────────────── */
  // Remove space between _ or ^ and the following {
  s = s.replace(/([_^])\s+(?=\{)/g, "$1");

  /* ── Step 9: restore protected display math ────────────────────── */
  s = restoreDisplayMath(s, store);

  /* ── Step 10: fix $$ opened but closed by single $ ──────────────── */
  // After all transforms, check for unmatched $$ blocks where the closing
  // delimiter is a single $ (typically at end of text).  Convert to $$.
  {
    const openDD = (s.match(/^\$\$/gm) || []).length;
    const closeDD = (s.match(/\$\$\s*$/gm) || []).length;
    if (openDD > closeDD) {
      // There are more opening $$ than closing $$ — find trailing single $
      // that should be $$.  Match $ at end of string or $ before trailing whitespace.
      s = s.replace(/([^$\n])\$\s*$/, "$1\n$$");
    }
  }

  return s;
}
