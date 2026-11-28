import { describe, expect, it } from "vitest";
import {
  chooseEmailBody,
  htmlToText,
  isViewInBrowserStub,
  sanitizeLinks,
  stripViewInBrowserNoise,
} from "../src/shared/emailText.js";
import {
  parseSchoolEmail,
  trimEmailBoilerplate,
  type EmailMessage,
} from "../src/shared/parseSchoolEmail.js";

// Synthetic, modelled on the structure of a school mass-mailer's message: a
// text/plain part that is only a pointer to the web copy, and the real content in HTML.
const STUB =
  "To view the contents of this message, click on the following link or copy and paste it into your browser:\n" +
  "https://school.example.org/view?i=ABC123&s=XYZ789\n";

const HTML = `<html><head><style>p { color: red }</style></head><body>
<p>If you are having trouble viewing this email, <a href="https://school.example.org/view?i=ABC123">click here</a></p>
<p>Hello families!&nbsp;</p>
<p>The Turkey Run is canceled due to rain. We&rsquo;ll share a new date soon &amp; thank you for your patience.</p>
<ul><li>Bring a water bottle</li><li>Wear sneakers</li></ul>
<script>track()</script></body></html>`;

describe("htmlToText", () => {
  it("keeps paragraphs and list items as separate lines", () => {
    const text = htmlToText(HTML);
    expect(text).toContain("Hello families!\n");
    expect(text).toContain("- Bring a water bottle\n- Wear sneakers");
  });

  it("decodes named and numeric entities, including &nbsp; and curly quotes", () => {
    const text = htmlToText("<p>It&rsquo;s &lt;3 &amp; a caf&#233; &#x2014; ok</p>");
    expect(text).toBe("It’s <3 & a café — ok");
    expect(htmlToText("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
  });

  it("drops style, script and comments, and never leaks a link URL", () => {
    const text = htmlToText(HTML + "<!-- hidden -->");
    expect(text).not.toMatch(/color: red|track\(\)|hidden|school\.example\.org|https?:/);
  });

  it("leaves an unknown entity untouched rather than guessing", () => {
    expect(htmlToText("<p>&notanentity;</p>")).toBe("&notanentity;");
  });
});

describe("isViewInBrowserStub", () => {
  it("recognises a text part that is only a pointer to the web copy", () => {
    expect(isViewInBrowserStub(STUB)).toBe(true);
  });

  it("does not mistake a real message for a stub, even one that mentions a link", () => {
    expect(
      isViewInBrowserStub("Hello families! The Turkey Run is canceled due to rain. See https://school.example.org/run for details."),
    ).toBe(false);
  });
});

describe("chooseEmailBody", () => {
  it("uses the HTML part when the plain part is only a stub", () => {
    const body = chooseEmailBody(STUB, HTML);
    expect(body).toContain("The Turkey Run is canceled due to rain");
    expect(body).not.toContain("To view the contents");
  });

  it("uses the HTML part when there is no plain part at all", () => {
    expect(chooseEmailBody(undefined, HTML)).toContain("Hello families!");
    expect(chooseEmailBody("", HTML)).toContain("Hello families!");
  });

  it("keeps a real plain part and ignores the HTML", () => {
    expect(chooseEmailBody("The real plain message, long enough to be real content here.", HTML)).toBe(
      "The real plain message, long enough to be real content here.",
    );
  });

  it("falls back to the stub text when there is no HTML to use", () => {
    expect(chooseEmailBody(STUB, false)).toBe(STUB.trim());
  });
});

describe("stripViewInBrowserNoise", () => {
  it("removes view-in-browser lines, bare URL lines and divider rows", () => {
    const cleaned = stripViewInBrowserNoise(
      [
        "If you are having trouble viewing this email, click here",
        "Real content line.",
        "----------",
        "https://school.example.org/view?i=1",
        "More content.",
      ].join("\n"),
    );
    expect(cleaned).toBe("Real content line.\nMore content.");
  });
});

describe("trimEmailBoilerplate — dividers", () => {
  it("keeps the whole message when a row of dashes is just a heading underline", () => {
    // This used to cut at the underline and keep only the title.
    const body = "** Inside the Spark!\n------------------------\nStory one.\n\nStory two.";
    expect(trimEmailBoilerplate(body)).toBe(body);
  });

  it("still cuts at an Outlook-style divider that introduces a quoted message", () => {
    const body = "My reply.\n________________________________\nFrom: Someone\nSent: Monday\nOld text.";
    expect(trimEmailBoilerplate(body)).toBe("My reply.");
  });

  it("cuts at an Original Message marker, a quoted line, and an 'On ... wrote:' line", () => {
    expect(trimEmailBoilerplate("Reply.\n-----Original Message-----\nFrom: A")).toBe("Reply.");
    expect(trimEmailBoilerplate("Reply.\n> quoted text")).toBe("Reply.");
    expect(trimEmailBoilerplate("Reply.\nOn Mon, Sep 21, 2026 at 9:00 AM A <a@example.org> wrote:\nOld")).toBe("Reply.");
  });
});

describe("parseSchoolEmail — a stub-only email now carries its real content", () => {
  const message: EmailMessage = {
    subject: "Turkey Run Canceled",
    date: "2026-11-19T14:00:00.000Z",
    fromDomain: "mail.example.org",
    body: chooseEmailBody(STUB, HTML),
    recipientCount: 1,
    hasListHeaders: false,
    bulkPrecedence: false,
    undisclosedRecipients: false,
  };

  it("publishes the message text as the description, without the view-in-browser line or its link", () => {
    const { events } = parseSchoolEmail(JSON.stringify({ messages: [message] }), {
      timeZone: "America/New_York",
      bulkDomains: ["mail.example.org"],
      broadcastChannel: true,
    });
    expect(events).toHaveLength(1);
    const description = events[0]!.description;
    expect(description).toContain("The Turkey Run is canceled due to rain");
    expect(description).toContain("- Bring a water bottle");
    expect(description).not.toMatch(/trouble viewing|To view the contents|https?:/);
  });
});

describe("sanitizeLinks — what is safe to publish", () => {
  it("keeps a useful public link but strips tracking parameters", () => {
    const text = "Sign up here: https://www.signupgenius.com/go/ABC123?mc_cid=c1&mc_eid=e1&utm_source=mail";
    expect(sanitizeLinks(text)).toBe("Sign up here: https://www.signupgenius.com/go/ABC123");
  });

  it("keeps meaningful query parameters", () => {
    expect(sanitizeLinks("Video: https://www.youtube.com/watch?v=abc123&utm_campaign=x")).toBe(
      "Video: https://www.youtube.com/watch?v=abc123",
    );
    expect(sanitizeLinks("File: https://drive.google.com/open?id=FILE123")).toBe(
      "File: https://drive.google.com/open?id=FILE123",
    );
  });

  it("drops a mailing-list unsubscribe or profile link entirely", () => {
    const text = [
      "Update your info: https://school.us7.list-manage.com/profile?u=U1&id=L1&e=RECIPIENT",
      "Leave: https://school.us7.list-manage.com/unsubscribe?u=U1&id=L1&e=RECIPIENT&c=C1",
      "Real content.",
    ].join("\n");
    const cleaned = sanitizeLinks(text);
    expect(cleaned).not.toMatch(/list-manage|RECIPIENT|unsubscribe/i);
    expect(cleaned).toContain("Real content.");
  });

  it("drops a link carrying a recipient-style token, even on an unknown host", () => {
    for (const url of [
      "https://portal.example.org/view?i=1&s=SIG&snd=2",
      "https://news.example.org/read?e=RECIPIENT",
      "https://news.example.org/read?token=SECRET",
      "https://news.example.org/read?email=a%40b.org",
    ]) {
      expect(sanitizeLinks(`See ${url} for more`)).not.toMatch(/https?:|SECRET|RECIPIENT|SIG/);
    }
  });

  it("does not swallow sentence punctuation that follows a link", () => {
    expect(sanitizeLinks("Details at https://www.example.org/page.")).toBe("Details at https://www.example.org/page.");
  });

  it("drops lines whose only job is managing a subscription", () => {
    const cleaned = sanitizeLinks("Content here.\nUnsubscribe from this list\nUpdate your preferences\nMore content.");
    expect(cleaned).toBe("Content here.\nMore content.");
  });

  it("leaves a message with no links unchanged", () => {
    expect(sanitizeLinks("Hello families!\n\nNo links here.")).toBe("Hello families!\n\nNo links here.");
  });
});

describe("parseSchoolEmail — links in a published description", () => {
  it("publishes the useful link and never the per-recipient ones", () => {
    const body = [
      "Hello families! Please sign up: https://www.signupgenius.com/go/ABC123?mc_eid=RECIPIENT",
      "Unsubscribe: https://school.us7.list-manage.com/unsubscribe?u=U1&e=RECIPIENT",
    ].join("\n");
    const { events } = parseSchoolEmail(
      JSON.stringify({
        messages: [
          {
            subject: "Sign up",
            date: "2026-11-19T14:00:00.000Z",
            fromDomain: "mail.example.org",
            body,
            recipientCount: 1,
            hasListHeaders: false,
            bulkPrecedence: false,
            undisclosedRecipients: false,
          },
        ],
      }),
      { timeZone: "America/New_York", broadcastChannel: true },
    );
    const description = events[0]!.description;
    expect(description).toContain("https://www.signupgenius.com/go/ABC123");
    expect(description).not.toMatch(/RECIPIENT|list-manage|mc_eid|Unsubscribe/i);
  });
});
