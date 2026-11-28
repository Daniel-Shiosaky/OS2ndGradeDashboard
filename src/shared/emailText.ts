// Turning an email's parts into the plain text that gets published.
//
// Many school mass-mailers (Blackbaud's, for one) send a multipart message whose
// text/plain part is only a stub — "To view the contents of this message, click
// on the following link" — while the real message lives in the HTML part. Taking
// the plain part whenever it exists meant those emails were published with no
// content at all.
//
// Isomorphic (no Node APIs) so it is unit-tested directly.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Plain text from an HTML email body.
 *
 * Paragraphs, line breaks, list items and table rows become line breaks so the
 * message keeps its shape. Link URLs are dropped on purpose: only the visible
 * text is kept, because a published link can carry a per-recipient token.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:style|script|head)[\s\S]*?<\/(?:style|script|head)>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|tr|h[1-6]|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lines that exist only to send a reader to a web copy of the message. They say
 * nothing about the content, and the link behind them is often per-recipient.
 */
const VIEW_IN_BROWSER_LINE = [
  /^to view the contents of this message/i,
  /^if you are having trouble viewing this (?:e-?mail|message)/i,
  /^(?:trouble viewing|having trouble viewing) /i,
  /^view (?:this (?:e-?mail|message) )?in (?:your |a )?(?:web )?browser/i,
  /^click (?:here|the following link) to view/i,
  /^(?:or )?copy and paste (?:the|this) (?:following )?(?:link|url)/i,
];

/**
 * Removes view-in-browser lines, bare URL lines and lines that are only a row of
 * dashes or similar (a heading underline reads as clutter once published).
 * Everything else is kept.
 */
export function stripViewInBrowserNoise(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (VIEW_IN_BROWSER_LINE.some((pattern) => pattern.test(trimmed))) return false;
      if (/^[-_=*~]{4,}$/.test(trimmed)) return false;
      return !/^https?:\/\/\S+$/i.test(trimmed);
    })
    .join("\n")
    .trim();
}

/**
 * True when a text/plain part carries no real message — it is only a pointer to
 * the web copy. Judged by what is left once that noise is removed.
 */
export function isViewInBrowserStub(plain: string): boolean {
  return stripViewInBrowserNoise(plain).replace(/\s+/g, " ").trim().length < 60;
}

/**
 * The text to publish for a message: the plain part, unless it is just a stub (or
 * empty), in which case the HTML part converted to text.
 */
export function chooseEmailBody(plain: string | undefined, html: string | false | undefined): string {
  const plainText = (plain ?? "").trim();
  const fromHtml = html ? htmlToText(html) : "";
  if (!plainText || isViewInBrowserStub(plainText)) return fromHtml || plainText;
  return plainText;
}

/* ---------- links in published text ---------- */

/** Tracking parameters carry no meaning for a reader and some identify the recipient. */
const TRACKING_PARAM = /^(?:mc_cid|mc_eid|mc_tc|utm_.+|fbclid|gclid|igshid|_hsenc|_hsmi|mkt_tok|vero_id)$/i;

/** Parameters that identify a person or a subscription, so the whole link is dropped. */
const PERSONAL_PARAM = /^(?:e|eid|uid|uuid|u|t|s|snd|sig|signature|auth|token|key|recipient|email|subscriber|sid)$/i;

/** Mailing-list management hosts: unsubscribe and profile pages. Never published. */
const LIST_MANAGEMENT_HOST = /(?:^|\.)list-manage\.com$/i;

/** Footer lines that manage a subscription. */
const SUBSCRIPTION_LINE =
  /unsubscribe|(?:update|manage|change) (?:your )?(?:subscription|preferences|profile|email preferences)|forward (?:this )?(?:email )?to a friend|view (?:this |it )?(?:email )?in your browser/i;

/**
 * Makes the links in an email safe to publish on a public page.
 *
 * Useful links (a sign-up sheet, a Drive file, the school site) are kept, with
 * tracking parameters removed. A link that identifies the recipient — an
 * unsubscribe or profile page, or one with a subscriber-style token such as `e=`
 * or `snd=` — is dropped entirely, because anyone who saw it could act as that
 * person. Lines that only manage a subscription are dropped too.
 */
export function sanitizeLinks(text: string): string {
  const cleaned = text.replace(/https?:\/\/[^\s<>()[\]"']+/gi, (rawUrl) => {
    // Trailing sentence punctuation is not part of the link.
    const trailing = rawUrl.match(/[.,;:!?]+$/)?.[0] ?? "";
    const candidate = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return "";
    }
    if (LIST_MANAGEMENT_HOST.test(url.hostname)) return "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    if ([...url.searchParams.keys()].some((key) => PERSONAL_PARAM.test(key))) return "";
    return url.toString() + trailing;
  });

  return cleaned
    .split(/\r?\n/)
    .filter((line) => !SUBSCRIPTION_LINE.test(line))
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
