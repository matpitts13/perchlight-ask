// Prints the ASK_API_KEYS hash of an API key: HMAC-SHA256("perchlight-ask:api-key", key), hex.
// Usage: npm run hash-key -- <key>     (no key: makes a new random one)
import { createHmac, randomBytes } from "node:crypto";

const key = process.argv[2] || `pa_${randomBytes(24).toString("base64url")}`;
if (key.length < 16) {
  console.error("An API key must be 16+ characters.");
  process.exit(1);
}
const hash = createHmac("sha256", "perchlight-ask:api-key").update(key).digest("hex");
if (!process.argv[2]) console.log(`key:  ${key}   (give this to your app; it isn't stored anywhere)`);
console.log(`hash: ${hash}`);
