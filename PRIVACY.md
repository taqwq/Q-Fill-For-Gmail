# Privacy policy

Last updated: November 21, 2026. Applies to Q-Fill for Gmail 2.1.0 and later (this fork).

Q-Fill is a browser extension that reads your recent Gmail messages to find a verification code and types it into the page you are on. It has no server. Nothing it reads is sent anywhere except between your browser and Google.

## What Q-Fill reads

- **Your recent Gmail messages**, only when you press **Fill code**, open the popup (if "Start looking right away" is on), use the shortcut, or, if you turned on **Suggest by the field**, when a page you are looking at focuses a field that clearly asks for a one-time code. Only messages received within your look-back window (10 minutes by default) plus one minute are read, because Gmail's search works in whole seconds. Q-Fill reads the subject, sender, body and Gmail's `Authentication-Results` header (to confirm the sender's domain), and ignores any message older than the window.
- **Your Gmail address**, once, when you connect, so the popup can show which account is connected.
- **The page you are on**, only after you click Q-Fill's icon or press its shortcut, and only to find the code field and type into it. Q-Fill reads the page's address to compare its domain with the sender's.
- **With Suggest by the field turned on only:** Chrome grants Q-Fill access to https sites. A small script then runs on https pages to notice when you focus a one-time-code field. It reads nothing else from the page, and it never receives the code until you click the suggestion.

Q-Fill uses Google's `gmail.readonly` scope. It cannot send, change, label or delete mail.

## What Q-Fill stores

| Data | Where | How long |
| --- | --- | --- |
| Your OAuth client ID | Browser local storage | Until you change it or remove the extension |
| Your look-back setting | Browser local storage | Until you change it or remove the extension |
| Your Gmail address | Browser local storage | Until you disconnect |
| Google access token | Browser session storage (memory only) | Until it expires, you disconnect, or the browser closes |
| The last code or confirmation link found, its sender and subject | Browser session storage (memory only) | Until the next run, you disconnect, or the browser closes |
| IDs of emails whose code was filled | Browser session storage (memory only) | Until you disconnect or the browser closes |
| Sender-to-site pairs you chose to trust, such as `bank.co.jp -> bankpay.jp` | Browser local storage | Until you remove them in Settings or remove the extension |
| Whether suggestions and "start looking right away" are on | Browser local storage | Until you change them or remove the extension |

Email bodies are never stored. They are held in memory only while a message is being scanned.

## What Q-Fill does not do

- It does not send your email, codes or browsing to the author or to anyone else. There is no server.
- It has no analytics, tracking, advertising or telemetry.
- It does not run on any page until you ask it to. Unless you turn on Suggest by the field, there is no content script on any site.
- It does not type a code into a page whose domain differs from the email's authenticated sender, unless you confirm it in the popup.
- It does not load remote code. Everything it runs ships inside the extension.

## Google sign-in

You sign in through Google's own window with an OAuth client that you create and own. Q-Fill never sees your Google password. Google's token is kept in memory only and is revoked at Google when you disconnect.

Q-Fill's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your controls

- **Disconnect:** Settings, then Disconnect Gmail. This revokes the token and clears session data.
- **Suggestions:** untick Suggest by the field in Settings. Q-Fill gives the site access back to Chrome and removes its page script.
- **Revoke at Google:** [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Remove everything:** remove the extension at `chrome://extensions`.

## Changes

Changes to this policy are made in this file, and its history is public in the repository.

## Contact

Questions about privacy in this fork: [open an issue](https://github.com/taqwq/Q-Fill-For-Gmail/issues). For anything sensitive, use a [private security advisory](https://github.com/taqwq/Q-Fill-For-Gmail/security/advisories/new) instead. The original project is [qbeka/Q-Fill-For-Gmail](https://github.com/qbeka/Q-Fill-For-Gmail).
