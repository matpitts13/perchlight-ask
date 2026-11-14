// perchlight-ask: ask-the-docs widget and API, plus AI-drafted support inbox
// replies, on Cloudflare Workers + Workers AI + Vectorize + D1 + one Durable
// Object. Your sources and settings are in ask.json at the repo root.
// There is no cron trigger (docs/SDD.md).
import config from "../ask.json";
import { makeWorker } from "./app.js";
import { keeperClass } from "./keeper.js";

export default makeWorker(config);
export const Keeper = keeperClass(config);
