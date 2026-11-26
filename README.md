<div align="center">

<img src="extension/icons/icon-128.png" width="72" height="72" alt="">

# Q-Fill for Gmail

Fill the verification code from your newest Gmail message into the page you are on with one click, without your email ever leaving your browser

[![CI](https://github.com/taqwq/Q-Fill-For-Gmail/actions/workflows/ci.yml/badge.svg)](https://github.com/taqwq/Q-Fill-For-Gmail/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1d3a2a.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/manifest-v3-1d3a2a.svg)
![No dependencies at runtime](https://img.shields.io/badge/runtime%20dependencies-0-1d3a2a.svg)

<img src="docs/images/fill.png" width="560" alt="A six-box code form filled with 204816, with a Q-Fill message at the bottom of the page">

</div>

> **This is a fork** of [qbeka/Q-Fill-For-Gmail](https://github.com/qbeka/Q-Fill-For-Gmail) that adds Japanese email support, a sender-to-site domain check and an optional one-tap suggestion under the code field. The Japanese summary follows; the rest of this README describes the extension as a whole.

## このフォークについて（日本語）

PC でも、スマートフォンの SMS 認証コードのように、メールで届いた認証コードを 1 タップで入力できるようにした改良版です。

### 追加したこと

- **日本語メールへの対応**: `認証コードは123456です`、`確認コード：１２３４５６`（全角）、`【591027】はあなたの…`、`ワンタイムパスワード`、`認証番号`、`パスコード` などを読み取ります。クーポンコード、注文番号、会員番号、〒、電話番号、金額、日付、ミーティングのパスコードは読み取りません。ISO-2022-JP、Shift_JIS（CP932）、EUC-JP の本文に対応しています。入力欄の検出も日本語のラベルに対応しています。
- **送信元とサイトのドメイン照合（必須）**: メールの送信元の登録可能ドメイン（例: `bank.co.jp`）と、入力先のページの登録可能ドメインが一致するときだけ、自動で入力します。判定には Public Suffix List を同梱して使うので、`evil.co.jp` と `bank.co.jp` を同じサイトとみなすことはありません。
- **送信元のなりすまし対策**: `From` は簡単に偽装できるので、Gmail 自身が付けた `Authentication-Results` ヘッダー（最上段の `mx.google.com` のもの）で DMARC、または From と整合する DKIM / SPF が pass しているメールだけを、その送信元のドメインからのメールとして扱います。
- **不一致のときは確認する**: ドメインが一致しない、送信元を確認できない、迷惑メールフォルダにある、のいずれかの場合は入力せず、ポップアップに送信元とページのドメインを並べて表示します。「それでも入力」で 1 回だけ入力できます。認証済みの送信元に限り「この組み合わせを常に信頼する」を選べます（設定から削除可能）。
- **入力の瞬間にもう一度確認**: 入力するフレームのオリジンを入力の直前にも確認し、検索中に別のページへ移っていたら入力しません。別サイトの iframe にも入力しません。https 以外のページには入力しません。
- **1 タップ**: ポップアップを開くと、すぐに検索を始めます（設定で切り替え可）。ショートカット `Alt+Shift+F` も使えます。
- **入力欄の下での提案（任意）**: 設定で「入力欄での候補表示」をオンにすると、コード入力欄を選んだときに、同じサイトから届いたコードを欄の下に提案します。クリックするまで、コードはページに渡しません（ページのスクリプトからのクリックは無視します）。この機能には https サイトへのアクセス権が必要で、オンにするときに Chrome が許可を求めます。
- **仮登録の確認リンク**: コードではなく「本登録を完了してください」のようなリンクが届くメールにも対応します。コード入力欄のないページで押すと、そのサイトから届いた確認リンクを、今のタブの隣に新しいタブで開きます。開くのは、Gmail が認証した送信元、リンク先、表示中のページの登録可能ドメインがすべて同じときだけです。配信サービスの計測用リンクのようにリンク先が別のドメインのときは、ポップアップに 3 つのドメインを並べ、「それでも開く」で 1 回だけ開けます。配信停止、ヘルプ、「心当たりがない場合」のリンクや、削除、解約、支払い、注文、変更、パスワード再設定のリンクは選びません。
- **日本語 UI**（`_locales/ja`）。

<table>
  <tr>
    <td><img src="docs/images/ja/popup-blocked.png" width="300" alt="別サイトからのコードを入力せず、送信元とページのドメインを並べて確認するポップアップ"></td>
    <td><img src="docs/images/ja/suggest-bar.png" width="420" alt="コード入力欄の下に、送信元ドメインと入力ボタンを表示した提案バー"></td>
  </tr>
</table>

### 使い方

インストールと Google OAuth クライアントの作成は、下の [Install](#install) と [docs/setup.md](docs/setup.md) のとおりです。設計と脅威モデルは [docs/PLAN-ja.md](docs/PLAN-ja.md) にあります。

### テスト

```
npm ci
npm run check          # lint、単体テスト、拡張機能の静的チェック
npx playwright install chromium
npm run test:e2e       # 実際の Chromium で拡張機能を動かす E2E テスト
```

## What it does

A site emails you a code. Instead of switching to Gmail, finding the email and copying six digits, you press **Fill code** (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) and Q-Fill:

1. Reads your most recent Gmail messages with read-only access.
2. Finds the verification code in the newest one that has a code **and was sent by the site you are on**: Gmail must have authenticated the sender (DMARC, or aligned DKIM/SPF), and the sender's registrable domain must match the page's.
3. Types it into the code field on the page, including split six-box fields, fields in iframes of the same site and fields inside web components.

A code from another site, an unauthenticated sender or the Spam folder is never filled on its own. The popup shows both domains and lets you fill it once, or trust that pair from then on.

If the email has not arrived yet, Q-Fill keeps checking for 90 seconds and fills the code the moment it lands. You can close the popup and keep working.

<table>
  <tr>
    <td><img src="docs/images/popup-filled.png" width="300" alt="Popup showing a filled code with a Copy button"></td>
    <td><img src="docs/images/popup-waiting.png" width="300" alt="Popup waiting for the verification email"></td>
  </tr>
</table>

## Why it is built this way

- **Your own OAuth client.** Q-Fill connects to Gmail through a Google OAuth client that you create. No company, including the author, holds a key to your inbox, and there is no server.
- **Nothing runs until you ask.** By default there is no content script on any site. Q-Fill touches a page only after you click its icon or press its shortcut, through Chrome's `activeTab` permission. The optional **Suggest by the field** setting asks Chrome for access to https sites, and you can turn it off at any time.
- **Read-only.** The only Gmail scope is `gmail.readonly`. Q-Fill cannot send, change or delete mail.
- **Memory only.** The access token, the last code and the list of emails already used live in `chrome.storage.session`, which the browser clears when it closes. See [PRIVACY.md](PRIVACY.md).
- **No build step.** The `extension/` folder is the extension. It has no runtime dependencies and loads as it is.

## Install

Q-Fill is not in the Chrome Web Store. You load it yourself and connect it to an OAuth client you create, which takes about five minutes once.

1. Download `q-fill-<version>.zip` from the [latest release](https://github.com/taqwq/Q-Fill-For-Gmail/releases/latest) and unzip it. Or clone the repository and use its `extension` folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder (or the repository's **`extension`** folder).
3. A setup page opens with your redirect URI. Follow [docs/setup.md](docs/setup.md) to create the OAuth client in Google Cloud, then paste its client ID into Q-Fill.
4. Click **Connect Gmail**, pick your account and allow "View your email messages and settings".

Works in Chrome 116 or later. Q-Fill signs in with `chrome.identity.launchWebAuthFlow`, which Edge, Brave, Arc, Vivaldi and Opera also provide, so it should work there too, but the automated tests run on Chromium only.

## Use

| You want to | Do this |
| --- | --- |
| Fill a code | Open the page that asks for it, then click the Q-Fill icon and press **Fill code** |
| Fill without opening the popup | Press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> on a Mac) |
| Open the popup from the keyboard | Press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd> |
| Paste the code yourself | Press **Copy** next to the code in the popup |
| Change the shortcuts | Settings, then **Change**, or go to `chrome://extensions/shortcuts` |
| Look further back than 10 minutes | Settings, then **Look back**: 2, 5, 10 or 30 minutes |

Q-Fill never fills the same email twice while the browser is open. If the only code in your inbox is one it already filled, it waits for a new email instead.

If you pressed **Resend** on a site, wait for the new email before pressing Fill. Otherwise Q-Fill may fill the older code, which is still within the look-back window.

## How it finds the right code

Every code-shaped token in the subject and body gets a score from the words around it. "Your code is 482913", "482913 is your Acme code" and a lone number in a large bold table cell score high. A number next to "order", "invoice", "%" or "promo code", a year, a phone number or a price scores low or is dropped. The best token above a threshold wins, and among emails Q-Fill picks the newest one with a code, not the one with the highest score.

It reads codes of 4 to 8 characters: digits (`482913`), spaced or dashed digits (`482 913`, `482-913`), and upper-case letters with digits (`K7Q2ZP`, `XKD-PTQ`). It understands the usual wording in English, Spanish, Portuguese, French, German, Italian, Polish, Russian, Japanese, Chinese and Korean.

On the 71 hand-written test emails in [test/fixtures/emails.js](test/fixtures/emails.js), 49 with a code and 22 without, the extractor gets all 71 right. The 1.x extractor got 44 of the same 71 right and filled years, follower counts and ticket numbers from emails with no code. These fixtures were written alongside the new extractor, some of them from a review that tried to break it, so treat 71 of 71 as a regression baseline, not a measured real-world accuracy. If Q-Fill misses a code in a real email, please [open an issue](https://github.com/qbeka/Q-Fill-For-Gmail/issues/new?template=missed_code.yml) with the wording around the code.

More detail, including how the page field is chosen, is in [docs/how-it-works.md](docs/how-it-works.md).

## Permissions

| Permission | Why |
| --- | --- |
| `identity` | Opens the Google sign-in window (`launchWebAuthFlow`). |
| `storage` | Keeps your client ID, Gmail address and look-back setting, plus the memory-only session data. |
| `activeTab` | Gives Q-Fill access to the current tab only after you click its icon or press its shortcut. |
| `scripting` | Puts the autofill script into that tab when you ask for a code. |
| `https://gmail.googleapis.com/*` | Lists and reads recent messages. |
| `https://oauth2.googleapis.com/*` | Revokes the token when you disconnect. |

There is no `<all_urls>`, no `tabs` permission and no content script on every page.

## Develop

You need Node.js 20 or later.

```bash
npm install
```

```bash
npm test
```

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests for code extraction, message parsing and the search loop (98 tests, under a second) |
| `npm run test:e2e` | Loads the real extension into Chromium and fills every page in `playground/`, then checks which fields the autofill script must and must not touch (31 tests, about 10 seconds). Run `npx playwright install chromium` once first |
| `npm run lint` | ESLint |
| `npm run check` | Lint, unit tests and static checks on `extension/` (manifest paths, strings, store limits, network hosts) |
| `npm run package` | Writes `dist/q-fill-<version>.zip` for the Chrome Web Store or Edge Add-ons |
| `npm run screenshots` | Regenerates the images in `docs/images/` |

The end-to-end tests fake only two things inside the service worker: Gmail's responses and the Google access token. Everything else, from the search loop to script injection to typing into the page, runs for real. To try the autofill by hand, serve the repository with `npx serve` and open `/playground/`.

After you change a file in `extension/`, click the reload icon on Q-Fill's card in `chrome://extensions`.

## Project layout

```
extension/                 the extension, loaded as it is
  manifest.json
  background/              service worker: sign-in, Gmail calls, filling
  core/                    pure logic shared with the tests: extract, parse, search
  content/autofill.js      injected on demand to pick a field and type the code
  popup/                   toolbar popup and first-run setup page
  shared/                  constants and i18n helper
  _locales/en/             every user-facing string
playground/                code forms of many kinds, used by the e2e tests
test/unit/                 node:test unit tests
test/e2e/                  Playwright tests against the real extension
scripts/                   checks, packaging, icons and screenshots
docs/                      setup guide, how it works, images
```

## Limits

- Q-Fill reads text. A code that only appears inside an image is not found.
- Codes longer than 8 characters, and codes in mixed or lower case letters, are not read.
- Pages that block extensions, such as the Chrome Web Store and `chrome://` pages, cannot be filled. The code is still shown in the popup to copy.
- A field inside an iframe from a different site than the page, as on some bank verification steps, cannot be filled, because clicking Q-Fill grants access to the page's own site only. The popup shows the code to copy.
- The Google sign-in window takes focus, so the popup closes while you sign in. Open it again afterwards.
- If the tab moves to a different site while Q-Fill waits for the email, the access you granted by clicking ends. Q-Fill then shows the code in the popup to copy instead of filling it.

## Contributing

Bug reports, missed codes and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The bundled Geist fonts are under the SIL Open Font License, see [extension/fonts/LICENSE.txt](extension/fonts/LICENSE.txt).
