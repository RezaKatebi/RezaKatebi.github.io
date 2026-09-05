#!/usr/bin/env python3
"""
Inject the shared nav and footer into every page.

The site is plain static files with no framework, but the nav and footer were
hand-copied into six pages, so changing a link meant six edits and one of them
had already drifted. The markup now lives once in partials/ and this script
stamps it between the BUILD markers in each page. Pages stay real static HTML
(no client-side templating), so nothing depends on JavaScript and there is
nothing for a crawler to miss.

Placeholders:
  {{ROOT}}  relative path back to the site root ("", "../", "../../", ...)
  {{HOME}}  how a page links to the homepage for an in-page anchor; empty on
            index.html so "#about" scrolls instead of navigating

Idempotent: run it as often as you like. Run it after editing partials/.
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

PAGES = {
    "index.html": "",
    "pages/chat.html": "../",
    "pages/research.html": "../",
    "pages/book-reviews.html": "../",
    "pages/blog/index.html": "../../",
    "pages/blog/posts/Consciousness.html": "../../../",
}

BLOCKS = {"nav": "partials/nav.html", "footer": "partials/footer.html"}


def render(template, root, page):
    home = "" if page == "index.html" else root + "index.html"
    return template.replace("{{ROOT}}", root).replace("{{HOME}}", home).rstrip("\n")


def main():
    check = "--check" in sys.argv
    changed = []
    for page, root in PAGES.items():
        path = os.path.join(ROOT, page)
        html = open(path).read()
        original = html
        for name, src in BLOCKS.items():
            template = open(os.path.join(ROOT, src)).read()
            body = render(template, root, page)
            pattern = re.compile(
                r"(<!-- BUILD:%s -->\n).*?(\n\s*<!-- /BUILD:%s -->)" % (name, name), re.S
            )
            if not pattern.search(html):
                sys.exit(f"error: {page} is missing the BUILD:{name} markers")
            html = pattern.sub(lambda m: m.group(1) + body + m.group(2), html)
        if html != original:
            changed.append(page)
            if not check:
                open(path, "w").write(html)
    if check:
        print("stale:" if changed else "all pages up to date", *changed)
        sys.exit(1 if changed else 0)
    print(f"updated {len(changed)} page(s)" + (": " + ", ".join(changed) if changed else ""))


if __name__ == "__main__":
    main()
