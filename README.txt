ETTYLINKS MATCHDAY PREDICTION MODEL (with paid registration)
Developed by ettylinks.dev@gmail.com | 0786317916 | +254 726 960 303

HOW IT WORKS
- Visitors see only the logo and the Register / Log in box. Predictions and match data are sent by the server only to approved, logged-in users.
- To register, a person pays KSh 30 to Pochi la Biashara +254 726 960 303, then registers with their M-Pesa confirmation code.
- You log in as the Developer, check the code and amount on your Pochi la Biashara SMS or statement, and press Approve. Only then can that person log in.
- New users also give a WhatsApp number. Pending users see clear status messages, a "Check my status" button, and a "Message us on WhatsApp" button that opens WhatsApp to +254 726 960 303 with their name and M-Pesa code filled in.
- In the Developer panel each person has a message menu (Approved, Still checking, Wrong amount, Code reused, Code not found) and a WhatsApp button that opens a ready message to their number.
- M-Pesa Pochi payments cannot be checked automatically from a free site, so approval is manual by design.

YOUR DEVELOPER LOGIN
You choose it. Nobody (including Claude) knows it. Set two values in Cloudflare (step 4 below):
  ADMIN_EMAIL     the email you will log in with
  ADMIN_PASSWORD  a long password only you know (12+ characters)
Then open the site, choose Log in, and use those two values. You get the Developer panel with pending payments, Approve / Reject / Remove, and a box to update match data.

FOLDERS
public/          The website (index.html, icons, manifest, sw.js, _headers)
src/worker.js    The private server code: registration, login, approvals, saved predictions, live feed
src/data.json    Starting match data. Private: only sent to approved, logged-in users
wrangler.toml    Cloudflare settings (you edit two things in it, see step 3)

SET UP ON CLOUDFLARE (free, about 15 minutes). This is the "Workers" flow, where Cloudflare runs: npx wrangler deploy
1. Put every file of this folder in your GitHub repository (replace the old ones; delete the old "functions" folder if it is still there).
2. In Cloudflare: Storage & databases > D1 SQL database > Create. Name it ettylinks-matchday. Open it and copy its Database ID.
3. In GitHub, open wrangler.toml and edit it:
   - name: must be exactly your Worker's name shown in Cloudflare (Workers & Pages).
   - database_id: paste the Database ID from step 2. Save (commit). Cloudflare redeploys by itself.
4. In Cloudflare open your Worker > Settings > Variables and Secrets > add:
   ADMIN_EMAIL     the email you will log in with (type: Text)
   ADMIN_PASSWORD  a long password only you know, 12+ characters (type: Secret)
5. Open your Worker's address (it ends in .workers.dev). The database tables are created automatically on first use.
Build settings should stay as Cloudflare set them: build command empty, deploy command npx wrangler deploy.
Command-line alternative: install Node, run  npx wrangler login  then  npx wrangler deploy  in this folder, then add the secrets with  npx wrangler secret put ADMIN_PASSWORD.

LIVE AND CONCLUDED GAMES (optional data feed)
The "Live and concluded games" card works in two ways:
1. Without a feed it scores the model on the finished games saved in the data (works straight away).
2. With a feed it also shows games in play with live-updated chances, and the games that finished in the last 36 hours, each marked hit or miss against the model's pre-match call.
To connect the feed:
  a. Register free at https://www.football-data.org/client/register and copy your API token.
  b. In Cloudflare: Settings > Variables and Secrets > add FOOTBALL_DATA_KEY (Secret). Optional: LIVE_TTL = seconds between refreshes (default 60, minimum 30).
  c. Retry the deployment.
The server asks the data source at most once per minute and shares the answer with every user, so the free limit (10 calls a minute) is safe however many people use the site.
Important: the free plan shows DELAYED scores, not real-time. football-data.org sells a live-scores plan (listed at about EUR 12 a month; check their pricing page). The free plan covers 12 competitions including the Premier League, La Liga, Serie A, Bundesliga and Ligue 1. Live chances are calculated for leagues in your data file (Premier League, La Liga, Serie A until you add more); other leagues show the score only.
Live chances use the elapsed time and current score with the same goals model. Where the source gives no minute, the minute is estimated from kick-off time.

KEEP IN MIND
- Never put ADMIN_EMAIL or ADMIN_PASSWORD in any file. Only in the Cloudflare settings.
- Passwords are stored salted and hashed. Sessions use secure cookies. Login attempts are limited (8 failures, then 15 minutes).
- Approve only after you see KSh 30 and the same code on your Pochi la Biashara record. Reusing a code is blocked.
- Updating match data: log in as Developer and paste new JSON in "Update match data", or edit src/data.json and redeploy. Ask Claude to generate fresh JSON for new dates or leagues.
- The model gives chances, not certainties. No system can honestly promise 90% across all matches.
- Check Kenyan rules on charging for betting-related tips and on data protection before you launch.
