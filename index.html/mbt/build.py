# Assembles the static site (public/index.html) from src/. Run: python3 build.py
import json, pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
css = (src / 'reset.css').read_text() + '\n' + (src / 'app.css').read_text()
eng = (src / 'engine.js').read_text()
app = (src / 'app.js').read_text()
seed = json.loads((src / 'seed.json').read_text())
data = json.dumps(seed, separators=(',', ':')).replace('<', '\\u003c')
for part in (eng, app):
    assert '</script' not in part.lower()
assert '</style' not in css.lower()
fonts = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Lato:wght@400;700;900&display=swap'
html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0D1F32">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Myrtle Beach">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="description" content="Tee times, teams, scores, skins, the Snake and the money for the Myrtle Beach golf trip.">
<title>Myrtle Beach Golf Trip</title>
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
<style>{css}</style>
</head>
<body>
<div id="app"></div>
<script id="trip-data" type="application/json">{data}</script>
<script>{eng}</script>
<script>{app}</script>
</body>
</html>
'''
out = root / 'public'
out.mkdir(exist_ok=True)
(out / 'index.html').write_text(html)
print('public/index.html', len(html), 'bytes')
