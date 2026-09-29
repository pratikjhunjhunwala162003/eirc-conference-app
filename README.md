# EIRC 51st Regional Conference App

Real working app — phone+OTP login, role-based permissions enforced on the
server, instant live sync via Socket.io, and the M2M schedule built entirely
in EIRC's own official Program Builder (unmodified), automatically feeding
the Logistics module.

## Run it locally
```
npm install
npm start
```
Open http://localhost:4000

## Deploy (Render, free tier)
1. Push this folder to a GitHub repo.
2. Render.com -> New + -> Web Service -> connect the repo.
3. Build command: npm install   Start command: npm start

## How the M2M integration works
- `public/m2m-builder.html` is EIRC's official Program Builder, copied in
  completely unmodified — not a single line changed.
- Whoever has M2M edit rights sees this builder directly (embedded) when they
  open the M2M tab. Everyone else sees a clean read-only schedule.
- Every few seconds while the builder is open, the app reads its live data
  (same-origin, no changes to the builder's own code) and syncs it to the
  backend, which automatically works out who still needs logistics finalized.
- Per Mayur's instruction: Dais members, Judges, and Speakers count as guests
  needing logistics. Master of Ceremonies and Vote of Thanks proposers do not.
- If someone is removed from the M2M entirely, their finalized logistics and
  any shadow assignment to them are automatically cleaned up.

## Test logins (OTP is always 1234 in this version)
- CA Mayur Agarwal — 9903349773 — Admin
- CA Aditya Maheshwari — 9733044550 — Admin

## Before the real event
1. Real SMS OTP provider (MSG91/Twilio) instead of the fixed demo code.
2. A real database (MySQL/Postgres) instead of the simple db.json file —
   Render's free tier wipes local files on every redeploy.
3. Add your real team and the real programme through the app itself.
