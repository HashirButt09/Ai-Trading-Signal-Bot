// Prints the secret values to paste into Vercel -> Settings -> Environment Variables.
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
const v = webpush.generateVAPIDKeys();
const word = () => randomBytes(18).toString('base64url');
console.log(`
Copy each line into Vercel -> Project -> Settings -> Environment Variables (name = value):

VAPID_PUBLIC_KEY   = ${v.publicKey}
VAPID_PRIVATE_KEY  = ${v.privateKey}
VAPID_SUBJECT      = mailto:you@example.com   (put your own email)
CRON_SECRET        = ${word()}
APP_PASSCODE       = ${word()}   (or any word you like; you type it into the app once)

Keep these private. Generate them once: new VAPID keys make every phone tap its bells again.
`);
