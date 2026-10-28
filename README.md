<p align="center"><img src="https://codegpt.it.com/static/brand/logo-1024.png" width="96" alt="Code GPT"></p>
<h1 align="center">Code GPT for Chrome</h1>
<p align="center">A browser agent in Chrome's side panel: it reads pages, clicks, types and fills forms for you, and asks before anything important.<br>
<a href="https://codegpt.it.com/chrome">Website</a> · <a href="https://codegpt.it.com/download">Download</a> · <a href="https://chat.codegpt.it.com/forum">Forum</a></p>

## Install

1. Download the newest `.zip` from [codegpt.it.com/download](https://codegpt.it.com/download) and unzip it into a folder.
2. Open `chrome://extensions`, turn on **Developer mode** (top right) and press **Load unpacked**. Choose the folder.
3. Pin Code GPT, open the side panel and press **Sign in**.

Works in Chrome, Edge and Brave.

## What it does

- **Chat** about the page you are on: summaries, replies, formulas, translations. Insert an answer into the box you clicked.
- **Agent**: describe a task ("sort my unread emails into a list", "fill this form with my details") and watch it work step by step.
- **You stay in control**: it shows its plan, asks before sending, buying, deleting or submitting, and stops when you press Stop.
- **Read-only mode** for when you only want it to look.
- **Protected against tricks**: text on a web page is treated as data, never as instructions, so a page cannot take over the agent.

## Files

- `manifest.json`: Manifest V3
- `background.js`, `panel.html`, `panel.js`, `panel.css`: the side panel
- `agent/`: what runs on web pages (reading, clicking, typing)
- `lib/`, `icons/`: shared code and icons

Made by [AMAR Developers](https://codegpt.it.com/about). See [LICENSE.txt](LICENSE.txt).
