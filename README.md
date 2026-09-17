# EIRC 51st Regional Conference App

A real working app — phone+OTP login, role-based permissions enforced on the
server (Admin / M2M / Logistics / Shadow), and instant live sync across every
device via Socket.io. Nobody passes files around; every edit updates everyone
else's screen automatically.

## Run it locally (to test on your own laptop first)
```
npm install
npm start
```
Then open http://localhost:4000 in a browser.

## Deploy it for free — Replit (fastest, about 2 minutes, gives you a live link today)
1. Go to replit.com and sign up free (no card needed).
2. Click "Create Repl" -> "Import from a ZIP" and upload this whole folder as a zip.
3. Click the green "Run" button at the top.
4. Replit shows you a public https:// web address in the preview pane — that's
   your live link. Copy it and send it to anyone, including the chairman.

## Deploy it for free — Render (more permanent, needs a GitHub account)
1. Push this folder to a new GitHub repository.
2. On render.com, click "New +" -> "Web Service" and connect that repo.
3. Build command: npm install
4. Start command: npm start
5. Deploy. You get a permanent link like https://your-app-name.onrender.com

## Test logins (demo data — the OTP is always 1234 in this version)
| Person | Phone | What they can do |
|---|---|---|
| CA Mayur Agarwal | 9830100001 | Admin — everything |
| Pratik (M2M head) | 9007388214 | Edit M2M only |
| Kaushik | 9830122223 | Edit Logistics only, view M2M |
| Partha | 9830111112 | View M2M and Logistics only, no editing |
| CA Pratik Jhunjhunwala | 9007388215 | Shadow — sees only Tehseen Poonawalla |

## Before this goes live for the real conference
1. **Real OTP** — swap the fixed "1234" code in `server.js` (`/api/auth/request-otp`)
   for a real SMS provider call, e.g. MSG91 or Twilio (needs a paid account,
   roughly ₹0.15–0.30 per SMS in India).
2. **A real database** — right now data is stored in a simple `db.json` file
   on the server, which works fine for a two-day event but should move to
   MySQL/Postgres for anything longer-running or higher-traffic.
3. **Add your real people and sessions** — nothing in this app is hardcoded
   permanently. Log in as Admin, go to Manage Access, and add Mayur's actual
   team by name and phone number; log in as the M2M head and enter the real
   schedule.
4. **Porting to Laravel** (if your team goes that route per your sir's advice) —
   this Node/Express code is a direct, working spec: the same routes,
   permission checks, and OTP flow translate cleanly into Laravel controllers,
   middleware, and Laravel Reverb for the real-time piece.
