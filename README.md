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
You choose it. Nobody (including Claude) knows it. Set two values in Cloudflare (step 5 below):
  ADMIN_EMAIL     the email you will log in with
  ADMIN_PASSWORD  a long password only you know (12+ characters)
Then open the site, choose Log in, and use those two values. You get the Developer panel with pending payments, Approve / Reject / Remove, and a box to update match data.

FOLDERS
public/      The website (index.html, icons, manifest, sw.js, _headers)
functions/   The private server code and match data. It is NOT visible to the public.
  api/[[path]].js   registration, login, approvals, saved predictions
  _data.json        starting match data
wrangler.toml        for the command-line route only

SET UP (about 15 minutes, free). Cloudflare Pages needs Git or Wrangler for server code; drag-and-drop upload does not run it.
OPTION A: GitHub, no coding
1. Create a free GitHub account and a new private repository. Upload everything in this folder (public, functions, wrangler.toml).
2. In Cloudflare: Workers & Pages > Create > Pages > Connect to Git. Pick the repository.
   Build command: leave empty. Build output directory: public. Deploy.
3. In Cloudflare: Storage & databases > D1 > Create database, name it ettylinks-matchday.
4. Open your Pages project > Settings > Bindings (or Functions) > Add > D1 database. Variable name: DB. Choose ettylinks-matchday.
5. Settings > Variables and Secrets > add ADMIN_EMAIL and ADMIN_PASSWORD (use Secret type for the password).
6. Deployments > Retry deployment so the settings take effect. Open your .pages.dev address.
The tables are created automatically the first time the site is used.
OPTION B: command line
npm i -g wrangler, wrangler login, wrangler d1 create ettylinks-matchday, paste the id into wrangler.toml,
wrangler pages secret put ADMIN_EMAIL and ADMIN_PASSWORD, then: wrangler pages deploy public

KEEP IN MIND
- Never put ADMIN_EMAIL or ADMIN_PASSWORD in any file. Only in the Cloudflare settings.
- Passwords are stored salted and hashed. Sessions use secure cookies. Login attempts are limited (8 failures, then 15 minutes).
- Approve only after you see KSh 30 and the same code on your Pochi la Biashara record. Reusing a code is blocked.
- Updating match data: log in as Developer and paste new JSON in "Update match data", or edit functions/_data.json and redeploy. Ask Claude to generate fresh JSON for new dates or leagues.
- The model gives chances, not certainties. No system can honestly promise 90% across all matches.
- Check Kenyan rules on charging for betting-related tips and on data protection before you launch.
