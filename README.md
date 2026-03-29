# BlueLedger

BlueLedger is a privacy-first personal finance dashboard built as a lightweight web app / PWA. It helps users track income, expenses, budgets, card-based wallets, and recurring transactions while keeping data stored locally on the device.

## Highlights

- PIN-protected local experience
- AES-encrypted local storage
- Multi-card wallet support
- Income and expense tracking
- Recurring transaction support
- Budget and category management
- CSV export and flexible CSV import
- Monthly, daily, weekly, and yearly reporting
- Mobile-friendly bottom navigation
- Offline-ready PWA support

## Tech Stack

- HTML
- CSS
- Vanilla JavaScript
- CryptoJS
- Local Storage
- Service Worker + Web App Manifest

## Project Structure

The current working UI in this repo is based on:

- [index (4).html](./index%20(4).html)
- [style (2).css](./style%20(2).css)
- [script (3).js](./script%20(3).js)

Older numbered files are preserved in the repository as previous iterations.

## Features

### Security

- User data is stored locally in the browser
- Vault data is encrypted with the user PIN
- Session PIN stays in memory during the active session
- Auto-lock support helps protect the app when inactive

### Finance Tracking

- Add income and expenses
- Search, sort, and filter transactions
- Track spending by category
- Set monthly spending limits
- Manage multiple wallets/cards separately

### Reports

- Daily report
- Weekly report
- Monthly report
- Yearly report
- Spending insights and category breakdowns

### Import / Export

- Export transactions to CSV
- Import CSV using the BlueLedger template
- Supports common alternate CSV header names
- Includes a downloadable sample import template in the app

## Running Locally

Because this is a static web app, you can run it in any simple local server.

### Option 1: Open directly

Open [index (4).html](./index%20(4).html) in a browser.

### Option 2: Run with a local server

If you use VS Code, the easiest option is Live Server.

You can also run a basic local server manually, for example:

```powershell
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/index%20(4).html
```

## PWA Notes

This project includes:

- [manifest.json](./manifest.json)
- [sw.js](./sw.js)

If you plan to deploy or package the app, make sure the service worker asset list matches the exact production files you want to ship.

## Privacy

BlueLedger is designed to be offline-first and privacy-focused.

- No backend is required
- No database server is required
- Data stays on the user device
- No analytics or tracking are intended

## Current Limitations

- Data is tied to the browser/device storage
- Losing the PIN can make stored data inaccessible
- This repo is currently a web app/PWA, not a native Android or iOS app
- Store deployment would require additional packaging, testing, and compliance work

## Roadmap Ideas

- Native Android packaging
- Better onboarding and recovery guidance
- Stronger import mapping UI
- Optional cloud backup with end-to-end encryption
- Improved charts and insights

## Screenshots

You can add screenshots here later, for example:

```md
![Dashboard](./screenshots/dashboard.png)
![Transactions](./screenshots/transactions.png)
![Reports](./screenshots/reports.png)
```

## License

Add your preferred license here.

Example:

```text
MIT
```

## Author

Built by Shrey Chauhan.

