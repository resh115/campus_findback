# FindBack

FindBack is a campus Lost & Found app for Students, Staff, Workers, and server-authorized Admin users.

## Run

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Fill Firebase Admin SDK settings, Firebase Web App settings, Backblaze B2 settings, Groq settings, and `ADMIN_UID`.
4. Run `npm install`.
5. Run `npm run check`.
6. Run `npm start`.
7. Open `http://localhost:5000`.

## Authentication

The browser uses Firebase email/password auth. Users enter email and password only; they never paste Firebase ID tokens. The frontend waits for `onAuthStateChanged`, obtains `user.getIdToken()`, and sends protected API requests with `Authorization: Bearer <token>`. A 401 refreshes the token once and retries.

The backend verifies tokens with Firebase Admin SDK and derives `req.user.uid` from the decoded token. It never trusts browser-supplied UIDs or roles. Public registration allows only Student, Staff, and Worker. Admin access is controlled by `ADMIN_UID`.

## Images

Images upload from the browser as `multipart/form-data`, pass through Multer validation, and are stored in the private Backblaze B2 bucket. Firestore stores only `imageKey` and an authenticated proxy URL. The browser loads protected images by fetching `/api/images/*key` with the Firebase bearer token, converting the response to a blob URL, and assigning that to the image element.

## Matching

Every new lost report is compared against found reports, and every new found report is compared against lost reports. Deterministic matching evaluates item identity, category, brand, color, description, distinctive details, location, and date proximity.

If Groq is configured, text matching uses `GROQ_MODEL`. When both reports have images, the backend reads private B2 objects server-side and sends the actual image data URLs to `GROQ_VISION_MODEL`. Groq failures are logged and do not block report creation.

## Workflow

The report lifecycle is:

`active -> possible_match -> confirmed_match -> return_pending -> resolved`

Rejecting a possible match returns both reports to `active`. Contact details are returned only after both parties confirm the match. Return resolution requires both sides to confirm return.

## PDF

`GET /api/reports/:id/pdf` generates a PDF with PDFKit. The PDF includes report fields, matching status, confirmation state, and the private image when it can be safely retrieved and embedded. Private contact details are included only after both confirmations.

## Security Notes

Do not commit `.env`, Firebase private keys, B2 application keys, Groq keys, logs, or `node_modules`. Firestore rules keep profile/report access scoped to authenticated users and keep `matches` and `auditLogs` server-only.
