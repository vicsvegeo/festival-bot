// One-time setup for Festival rotation end times. Turns an Epic authorization
// code into a device auth the bot can log in with indefinitely.
//
// 1. Log in to epicgames.com (an alt account is best), then open
//    https://www.epicgames.com/id/api/redirect?clientId=3f69e56c7649492c8cc29f1af08a8a12&responseType=code
// 2. Copy the "authorizationCode" value (it expires in ~5 minutes).
// 3. With EPIC_CLIENT set: npm run epic-login -- <code>
// 4. Put the printed EPIC_DEVICE_AUTH line in the bot's environment.
import "dotenv/config";
import { epicToken } from "../src/epic.js";

const code = process.argv[2];
if (!code) {
  console.error("usage: npm run epic-login -- <authorizationCode>");
  process.exit(1);
}

const login = await epicToken({ grant_type: "authorization_code", code, token_type: "eg1" });
const res = await fetch(
  `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/${login.account_id}/deviceAuth`,
  { method: "POST", headers: { Authorization: `Bearer ${login.access_token}` } },
);
if (!res.ok) {
  console.error(`creating the device auth failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { accountId, deviceId, secret } = (await res.json()) as Record<string, string>;
console.log(`EPIC_DEVICE_AUTH=${accountId}:${deviceId}:${secret}`);
