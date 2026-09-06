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
import hashlib
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

ASSETS = ["css/main.css", "js/app.js", "js/chat.js", "js/profile.js", "js/chat-worker.js"]


def stamp():
    """Short hash of the assets, so a deploy changes every asset URL.

    GitHub Pages serves assets with max-age=600. Without a version in the URL a
    visitor keeps running ten-minute-old JavaScript after a deploy, which looks
    exactly like the fix not working. Hashing content means the URL only changes
    when something actually changed.
    """
    h = hashlib.sha256()
    for rel in ASSETS:
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            h.update(open(p, "rb").read())
    return h.hexdigest()[:8]


def version_assets(html, root, tag):
    """Point every local css/js reference at ...?v=<hash>."""
    def sub(m):
        attr, path = m.group(1), m.group(2)
        base = path.split("?")[0]
        return f'{attr}="{base}?v={tag}"'
    return re.sub(r'(href|src)="((?:\.\./)*(?:css|js)/[\w.-]+\.(?:css|js))(?:\?v=[0-9a-f]+)?"', sub, html)


def render(template, root, page):
    home = "" if page == "index.html" else root + "index.html"
    return template.replace("{{ROOT}}", root).replace("{{HOME}}", home).rstrip("\n")


def main():
    check = "--check" in sys.argv
    tag = stamp()
    changed = []

    # chat.js imports profile.js directly, so that specifier needs the same
    # treatment or a fresh chat.js can still pull a stale profile.
    chat = os.path.join(ROOT, "js/chat.js")
    src = open(chat).read()
    new_src = re.sub(r'from "\./profile\.js(?:\?v=[0-9a-f]+)?"', f'from "./profile.js?v={tag}"', src)
    if new_src != src and not check:
        open(chat, "w").write(new_src)
        tag = stamp()   # chat.js changed, so the hash moves
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
        html = version_assets(html, root, tag)
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
