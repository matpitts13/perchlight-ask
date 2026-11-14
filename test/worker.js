// The Worker under test: the app and the Keeper built around the tests' config.
import { makeWorker } from "../src/app.js";
import { keeperClass } from "../src/keeper.js";
import { TEST_CONFIG } from "./config.js";

export default makeWorker(TEST_CONFIG);
export const Keeper = keeperClass(TEST_CONFIG);
