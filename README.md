# Rupee Pulse - Simple Setup Guide

Rupee Pulse is an installable mobile web app for your Google Pay PDF statements.

## What the App Does

- Imports monthly Google Pay PDF statements.
- Reads transactions on your device.
- Shows daily spend bars with your daily limit line.
- Marks over-limit days in red.
- Shows cumulative extra spend and monthly savings.
- Shows cash flow by bank.
- Guesses categories from merchant/payee names.
- Shows AI confidence, category reasoning, and a review queue for uncertain transactions.
- Lets you correct categories and remembers them.
- Tracks merchants through two clean sections: frequent merchants and recurring merchants.
- Lets you tap a merchant to see all paid and received transactions with that person or business.
- Includes searchable ledger, budgets, daily limits, category views, and cash-flow views.
- Generates a private AI monthly coach score with overspend, confidence, and review signals.
- Supports multiple profiles, so you can keep your own statements separate from family or friends.
- Lets you tap a day, category, or merchant to see the detailed transactions behind it.
- Supports an optional encrypted vault passcode for saved app data.
- Exports a backup file.

## Where Your Data Is Stored

This version stores your data in the app storage of your phone using two layers:

- `IndexedDB`: stronger app database storage for installed web apps.
- `localStorage`: quick backup copy for fast startup.

That means:

- Your PDF and transactions are not uploaded to a server by this app.
- The data stays on the phone/browser where you use the app.
- If you clear browser/app data, uninstall the app, or change phone, the data may be removed.
- Use `Export backup` regularly. It downloads a JSON backup file that you can restore later.
- If you enable the encrypted vault, remember the passcode. The app cannot recover encrypted data without it.

The app is local-first, so there is no cloud account and no server reading your finance data. You can also enable `Encrypted vault` in Settings. That uses your app passcode to encrypt saved finance data on this phone before it is written to app storage.

True end-to-end encryption becomes important when cloud sync is added later. If cloud sync is added, the safest design is: encrypt data on your phone first, then upload only encrypted data.

## Where the Code Is Stored

The app code is in this folder:

`outputs/rupee-pulse-app`

Main files:

- `index.html`: the app screen.
- `styles.css`: the design.
- `app.js`: PDF import, calculations, charts, storage, and app logic.
- `manifest.webmanifest`: tells Android/Chrome this app is installable.
- `service-worker.js`: makes the app work offline after first load.

## How Hosting Works

This is a static app. It does not need a paid server.

Good beginner-friendly hosting options:

- Netlify Drop: easiest. Drag this folder into Netlify and it gives you a link.
- GitHub Pages: free, but needs a GitHub account and a few setup steps.
- Vercel: free, also simple if you use GitHub.

For mobile installation, hosting must use HTTPS. Netlify, GitHub Pages, and Vercel all provide HTTPS.

When opened as a normal browser tab, Android can still show browser UI. For the app-like experience, install it from Chrome using `Install app` or `Add to Home screen`. For a completely native app with no browser dependency at all, package this project later with Capacitor or a native Android wrapper and install the APK.

## How to Install on Android

1. Host the `rupee-pulse-app` folder using Netlify, GitHub Pages, or Vercel.
2. Open the hosted link in Chrome on your Android phone.
3. Tap the Chrome menu.
4. Tap `Add to Home screen` or `Install app`.
5. The app appears on your phone like a normal app.

## How to Install on iPhone

1. Open the hosted link in Safari.
2. Tap the Share button.
3. Tap `Add to Home Screen`.
4. Open it from the home screen.

Note: this first version is best on Android Chrome/Edge because the PDF parser runs locally in the browser. If iPhone Safari cannot import a PDF, the next upgrade should use a small hosted PDF-parsing backend or a native app wrapper.

## How You Will Use It Monthly

1. Download your Google Pay monthly PDF statement.
2. Open Rupee Pulse.
3. Tap `Import PDF`.
4. Choose the statement PDF.
5. Review categories under `More > Ledger`.
6. Export a backup after important imports.

## Profiles

Use the profile area at the top of the app to create or switch profiles. Import statements only after selecting the correct profile. This keeps each person's Google Pay data separate.

## Important Note

This first version is private and local-first. Later, if you want login, cloud sync, automatic backup, or a native Play Store APK, this same app can be upgraded.
