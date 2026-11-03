# FinTrack Daily Financial Email — setup notes

## Confirmed behaviour
- Schedule: daily at 08:00 Asia/Kolkata.
- Recipient: the signed-in Firebase Authentication account email (must be verified).
- Provider: Resend.
- Preference document: `users/{uid}/settings/dailyFinancialEmail`.
- Source portfolio: existing `users/{uid}/portfolio/main` document.

## Files
- `FinTrack_v116_daily_email_preferences.html`: v115 plus a Profile > Daily Financial Email preference page. It stores the opt-in preference in the user's Firestore settings document.
- `FinTrack_daily_email_function.js`: Firebase Functions v2 scheduled function using Resend.

## Deploy prerequisites
1. Use the Firebase project already configured by FinTrack. Set up Firebase Functions (Node.js 20 or later) and enable the Cloud Scheduler / Cloud Functions billing requirements for that project.
2. Put the function file in the project's `functions/index.js` (or export it from the existing index); do not overwrite existing functions.
3. Install dependencies in the functions directory: `npm install firebase-admin firebase-functions resend`.
4. Verify a sending domain in Resend. Set the `FROM_EMAIL` constant (or `FINTRACK_FROM_EMAIL` environment variable) to an address on that verified domain. The default `.example` sender is deliberately non-deliverable.
5. Set the secret: `firebase functions:secrets:set RESEND_API_KEY`.
6. Deploy: `firebase deploy --only functions:sendDailyFinancialEmail`.
7. Sign in to FinTrack with a verified Firebase email, open Profile > Daily Financial Email, enable it and save.

## Firestore document
`users/{uid}/settings/dailyFinancialEmail` stores only delivery preferences and delivery status. The backend obtains the destination email from Firebase Authentication rather than trusting a client-supplied address.

## Important current limitation — do not skip
The scheduled function deliberately does **not** report Total Available Cash or Safe to Spend yet. FinTrack's existing account balance and safe-to-spend calculations are implemented in the HTML client and depend on its transaction/transfer and reserve rules. Reimplementing them independently without first extracting the exact shared calculation could send materially wrong financial figures. The email clearly labels this limitation. Before enabling those two figures, move the exact existing pure calculation into a shared module and test it against the app's current outputs, including internal transfers, required budget carry-forward, unpaid EMI estimate and protected reserve.

The initial function reports month-to-date income/expense (excluding transfer records), net cash flow, category actual/required/planned, and a loan snapshot. It is a first backend integration slice, not yet a complete production release.

## Required production checks
- Confirm Firestore rules permit the signed-in user to write only their own settings document; do not loosen portfolio rules globally.
- Verify Resend domain and sender before sending.
- Test one account with known transactions and budgets; compare every email amount to FinTrack.
- Test opt-out, unverified email, duplicate prevention, missing portfolio, Resend failure and retry.
- Confirm timezone execution in the deployed Firebase region and review Cloud Function logs.
- Consider adding an authenticated callable function for a user-triggered test email; this initial scheduled function intentionally has no public HTTP endpoint.

## Security notes
- Never place the Resend API key in the HTML or Firestore.
- The client writes preference only; recipient is read from Firebase Auth server-side.
- The scheduled function is idempotent per user/day using `lastSentDate`.
- The email contains sensitive financial information; the user must explicitly opt in.
