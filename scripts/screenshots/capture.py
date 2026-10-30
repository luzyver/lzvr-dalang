"""Capture the current frontend using fictional, fully intercepted API responses."""

import argparse
import base64
import json
import mimetypes
import shutil
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import sync_playwright

from fixtures import NOW, preferences, response

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"
ORIGIN = "http://screenshots.test"
OUTPUTS = ("hero.png", "diff.png", "code-editor.png", "sql-editor.png", "light-mode.png", "mobile.png")


def install_routes(context, failures):
    def handle(route):
        request = route.request
        url = urlsplit(request.url)
        try:
            if f"{url.scheme}://{url.netloc}" != ORIGIN:
                raise ValueError(f"External request blocked: {request.url}")
            path = unquote(url.path)
            if path == "/api/conversations/pagination/events":
                route.fulfill(content_type="text/event-stream", body=": demo\n\n")
            elif path.startswith("/api/"):
                data = response(path, parse_qs(url.query), request.method)
                route.fulfill(content_type="application/json", body=json.dumps(data))
            else:
                file = (PUBLIC / ("index.html" if path in ("/", "/code", "/sql") else path.lstrip("/"))).resolve()
                if not file.is_relative_to(PUBLIC) or not file.is_file():
                    raise ValueError(f"Missing or disallowed asset: {path}")
                mime = "text/javascript" if file.suffix in (".js", ".mjs") else mimetypes.guess_type(file)[0]
                route.fulfill(content_type=mime or "application/octet-stream", body=file.read_bytes())
        except (KeyError, ValueError) as error:
            print(str(error), flush=True)
            failures.add(str(error))
            route.fulfill(status=500, content_type="application/json", body=json.dumps(dict(error=str(error))))

    context.route("**/*", handle)


def new_page(browser, failures, theme="dark", mobile=False):
    context = browser.new_context(viewport=dict(width=390 if mobile else 1440, height=844 if mobile else 900),
                                  device_scale_factor=2 if mobile else 1.5, is_mobile=mobile,
                                  has_touch=mobile, service_workers="block", timezone_id="Asia/Jakarta")
    install_routes(context, failures)
    context.add_init_script("for (const [key, value] of Object.entries(" + json.dumps(preferences(theme)) + ")) localStorage.setItem(key, value);")
    page = context.new_page()
    page.clock.set_fixed_time(NOW)
    def on_error(error):
        failures.add(f"Browser error: {error}")
        print(f"Browser error: {error}", flush=True)
    page.on("pageerror", on_error)
    page.on("console", lambda message: on_error(message.text) if message.type == "error" else None)
    return context, page


def ready(page, selector):
    try:
        page.locator(selector).first.wait_for(timeout=15000)
    except Exception:
        print(page.locator('body').inner_text(), flush=True)
        raise
    page.evaluate("document.fonts.ready")
    # Let asynchronous editor highlighting and layout settle after fonts load.
    page.wait_for_timeout(600)


def screenshot(page, path):
    if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
        raise RuntimeError(f"Horizontal overflow in {path.name}")
    page.mouse.move(0, 0)
    page.screenshot(path=str(path), animations="disabled")
    print(f"Captured {path.name}", flush=True)


def image_uri(path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def compose(browser, desktop, home, chat, output):
    """Browser-rendered device frames around unchanged UI captures."""
    context = browser.new_context(viewport=dict(width=1920, height=1160), device_scale_factor=1)
    page = context.new_page()
    css = """
      * { box-sizing: border-box } body { margin: 0; background: radial-gradient(ellipse at 20% 10%, #39304e, transparent 65%), #17171d; }
      .desktop { position: absolute; left: 66px; top: 72px; width: 1632px; border: 1px solid #ffffff24; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 90px #0007; }
      .bar { height: 40px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: #25252c; color: #a6a6b0; font: 12px Arial, sans-serif; }
      .bar i { width: 8px; height: 8px; border-radius: 50%; background: #686874; }
      .bar span { margin: auto; padding-right: 40px; }
      img { display: block; width: 100%; }
      .phone { position: absolute; border: 7px solid #36363f; border-radius: 36px; overflow: hidden; box-shadow: 0 24px 80px #0008; background: #17171d; }
      .hero-phone { width: 320px; right: 40px; bottom: 35px; }
    """
    page.set_content(f'<style>{css}</style><div class="desktop"><div class="bar"><i></i><i></i><i></i><span>app.example.com · Demo</span></div><img src="{image_uri(desktop)}"></div><div class="phone hero-phone"><img src="{image_uri(home)}"></div>')
    page.locator("img").evaluate_all("imgs => Promise.all(imgs.map(i => i.decode()))")
    screenshot(page, output / "hero.png")
    page.set_viewport_size(dict(width=940, height=980))
    page.set_content(f'<style>{css}.phone {{ width: 404px; top: 50px; }} .left {{ left: 48px; }} .right {{ right: 48px; }}</style><div class="phone left"><img src="{image_uri(home)}"></div><div class="phone right"><img src="{image_uri(chat)}"></div>')
    page.locator("img").evaluate_all("imgs => Promise.all(imgs.map(i => i.decode()))")
    screenshot(page, output / "mobile.png")
    context.close()


def capture(output):
    failures = set()
    with tempfile.TemporaryDirectory(prefix="readme-captures-") as temp, sync_playwright() as pw:
        scratch = Path(temp)
        staged = scratch / "output"
        staged.mkdir()
        browser = pw.chromium.launch()
        context, page = new_page(browser, failures)
        page.goto(ORIGIN + "/#c=pagination")
        ready(page, ".commit-box")
        page.get_by_text("Reviewer: no problems found (round 1)", exact=True).wait_for()
        page.locator('.commit-box textarea').fill("feat: add cursor pagination to products")
        screenshot(page, scratch / "desktop.png")
        page.locator('.file').filter(has_text="src/routes/products.ts").click()
        ready(page, ".diff-dialog-body")
        screenshot(page, staged / "diff.png")
        page.goto(ORIGIN + "/code#c=pagination")
        ready(page, ".cm-content")
        page.evaluate("async () => { const {reveal} = await import('/js/code-files.js'); await reveal('pagination', 'src/routes/products.ts'); }")
        ready(page, ".tree-row.selected")
        screenshot(page, staged / "code-editor.png")
        page.goto(ORIGIN + "/sql")
        ready(page, ".cm-content")
        page.locator(".cm-content").click()
        page.keyboard.press("Control+Enter")
        ready(page, ".sql-grid tbody tr")
        screenshot(page, staged / "sql-editor.png")
        context.close()

        context, page = new_page(browser, failures, theme="light")
        page.goto(ORIGIN + "/")
        ready(page, ".overview .usage-line")
        screenshot(page, staged / "light-mode.png")
        context.close()

        context, page = new_page(browser, failures, mobile=True)
        page.goto(ORIGIN + "/")
        ready(page, ".overview")
        screenshot(page, scratch / "home-mobile.png")
        page.locator('.ov-row').filter(has_text="Add cursor pagination").click()
        ready(page, ".composer")
        page.get_by_text("Reviewer: no problems found (round 1)", exact=True).wait_for()
        screenshot(page, scratch / "chat-mobile.png")
        context.close()
        compose(browser, scratch / "desktop.png", scratch / "home-mobile.png", scratch / "chat-mobile.png", staged)
        browser.close()
        if failures:
            raise RuntimeError("Capture validation failed:\n" + "\n".join(sorted(failures)))
        # Publish only after every view rendered successfully.
        output.mkdir(parents=True, exist_ok=True)
        for name in OUTPUTS:
            shutil.copyfile(staged / name, output / name)
    print("All six captures rendered without browser errors or unhandled requests.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "screenshots")
    capture(parser.parse_args().output.resolve())
